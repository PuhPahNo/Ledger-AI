import { google } from 'googleapis';
import { eq } from 'drizzle-orm';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import { connections, receipts } from '../db/schema.js';
import { decryptText, encryptText } from '../lib/crypto.js';
import { serviceUnavailable } from '../lib/errors.js';
import { storage } from './storage.js';

const gmailScopes = ['https://www.googleapis.com/auth/gmail.readonly'];

export function googleOAuthClient() {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    return null;
  }
  return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
}

export function gmailOAuthUrl(state: string): string {
  const client = googleOAuthClient();
  if (!client) {
    serviceUnavailable('Google OAuth is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in Render, then redeploy.');
  }
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: gmailScopes,
    state,
  });
}

export async function connectGmail(code: string, businessId?: string): Promise<string> {
  const client = googleOAuthClient();
  if (!client) {
    serviceUnavailable('Google OAuth is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in Render, then redeploy.');
  }
  const tokenResponse = await client.getToken(code);
  client.setCredentials(tokenResponse.tokens);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress ?? 'gmail';

  const [connection] = await db.insert(connections).values({
    businessId,
    kind: 'gmail',
    label: email,
    gmailEmail: email,
    status: 'live',
    encryptedAccessToken: tokenResponse.tokens.access_token ? encryptText(tokenResponse.tokens.access_token) : null,
    encryptedRefreshToken: tokenResponse.tokens.refresh_token ? encryptText(tokenResponse.tokens.refresh_token) : null,
    gmailHistoryId: profile.data.historyId ? String(profile.data.historyId) : null,
  }).returning();

  await renewGmailWatch(connection.id);
  return connection.id;
}

export async function renewGmailWatch(connectionId: string): Promise<void> {
  const env = getEnv();
  if (!env.GOOGLE_PUBSUB_TOPIC) return;
  const { gmail, connection } = await gmailClientForConnection(connectionId);
  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: env.GOOGLE_PUBSUB_TOPIC,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    },
  });
  await db.update(connections).set({
    gmailHistoryId: res.data.historyId ? String(res.data.historyId) : connection.gmailHistoryId,
    gmailWatchExpiration: res.data.expiration ? new Date(Number(res.data.expiration)) : null,
    lastSyncAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(connections.id, connectionId));
}

export async function syncGmailConnection(connectionId: string, historyId?: string): Promise<number> {
  const { gmail, connection } = await gmailClientForConnection(connectionId);
  const startHistoryId = connection.gmailHistoryId ?? historyId;
  if (!startHistoryId) return backfillGmail(connectionId, 'newer_than:30d (receipt OR invoice OR order OR confirmation)');

  const history = await gmail.users.history.list({
    userId: 'me',
    startHistoryId,
    historyTypes: ['messageAdded'],
  });

  const messageIds = new Set<string>();
  for (const item of history.data.history ?? []) {
    for (const added of item.messagesAdded ?? []) {
      if (added.message?.id) messageIds.add(added.message.id);
    }
  }

  let count = 0;
  for (const messageId of messageIds) {
    count += await ingestGmailMessage(connectionId, messageId);
  }

  await db.update(connections).set({
    gmailHistoryId: history.data.historyId ? String(history.data.historyId) : historyId ?? connection.gmailHistoryId,
    lastSyncAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(connections.id, connectionId));
  return count;
}

export async function backfillGmail(connectionId: string, query: string): Promise<number> {
  const { gmail } = await gmailClientForConnection(connectionId);
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 50 });
  let count = 0;
  for (const message of list.data.messages ?? []) {
    if (message.id) count += await ingestGmailMessage(connectionId, message.id);
  }
  return count;
}

async function ingestGmailMessage(connectionId: string, messageId: string): Promise<number> {
  const { gmail, connection } = await gmailClientForConnection(connectionId);
  const message = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const payload = message.data.payload;
  const attachments = collectAttachments(payload);
  let count = 0;
  for (const attachment of attachments) {
    const existing = await db.query.receipts.findFirst({ where: eq(receipts.gmailAttachmentId, attachment.attachmentId) });
    if (existing) continue;
    const data = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachment.attachmentId,
    });
    const buffer = Buffer.from(data.data.data ?? '', 'base64url');
    const key = `receipts/gmail/${connection.id}/${messageId}/${attachment.filename}`;
    await storage().put({ key, body: buffer, contentType: attachment.mimeType });
    await db.insert(receipts).values({
      businessId: connection.businessId,
      source: 'gmail',
      status: 'pending',
      fileKey: key,
      fileName: attachment.filename,
      mimeType: attachment.mimeType,
      gmailMessageId: messageId,
      gmailAttachmentId: attachment.attachmentId,
      ocrJson: {
        subject: header(payload, 'Subject'),
        from: header(payload, 'From'),
        date: header(payload, 'Date'),
      },
    });
    count += 1;
  }
  return count;
}

async function gmailClientForConnection(connectionId: string) {
  const client = googleOAuthClient();
  if (!client) throw new Error('Google OAuth is not configured');
  const connection = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
  if (!connection?.encryptedRefreshToken) throw new Error('Gmail connection is missing a refresh token');
  client.setCredentials({
    refresh_token: decryptText(connection.encryptedRefreshToken),
    access_token: connection.encryptedAccessToken ? decryptText(connection.encryptedAccessToken) : undefined,
  });
  return { gmail: google.gmail({ version: 'v1', auth: client }), connection };
}

function collectAttachments(part: any): Array<{ filename: string; mimeType: string; attachmentId: string }> {
  if (!part) return [];
  const current = part.body?.attachmentId && part.filename
    ? [{ filename: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', attachmentId: part.body.attachmentId }]
    : [];
  return [
    ...current,
    ...(part.parts ?? []).flatMap((child: any) => collectAttachments(child)),
  ].filter((attachment) => /pdf|image|receipt|invoice/i.test(`${attachment.mimeType} ${attachment.filename}`));
}

function header(part: any, name: string): string | undefined {
  const match = part?.headers?.find((item: { name?: string; value?: string }) => item.name?.toLowerCase() === name.toLowerCase());
  return match?.value;
}
