import { google } from 'googleapis';
import { and, eq } from 'drizzle-orm';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import { connections, receipts } from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { decryptText, encryptText } from '../lib/crypto.js';
import { serviceUnavailable } from '../lib/errors.js';
import {
  buildEmailBodyCandidate,
  collectReceiptAttachments,
  header,
  looksLikeReceiptOrInvoiceText,
  sanitizeFileName,
  type GmailAttachmentCandidate,
  type GmailBodyCandidate,
  type GmailMimePart,
} from './gmailReceiptIntake.js';
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
  const payload = message.data.payload as GmailMimePart | undefined;
  const subject = header(payload, 'Subject');
  const from = header(payload, 'From');
  const date = header(payload, 'Date');
  const messageSignal = [
    subject,
    from,
    date,
    message.data.snippet,
  ].filter(Boolean).join('\n');
  const messageIsReceiptLike = looksLikeReceiptOrInvoiceText(messageSignal);
  const attachments = collectReceiptAttachments(payload, messageIsReceiptLike);
  let count = 0;
  for (const attachment of attachments) {
    const data = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachment.attachmentId,
    });
    const buffer = Buffer.from(data.data.data ?? '', 'base64url');
    const inserted = await insertGmailAttachmentReceipt({
      connectionId: connection.id,
      businessId: connection.businessId ?? undefined,
      messageId,
      attachment,
      buffer,
      emailMetadata: { subject, from, date },
    });
    if (inserted) count += 1;
  }

  if (attachments.length === 0) {
    const bodyCandidate = buildEmailBodyCandidate({ payload, subject, from, date });
    if (bodyCandidate) {
      const inserted = await insertGmailBodyReceipt({
        connectionId: connection.id,
        businessId: connection.businessId ?? undefined,
        messageId,
        bodyCandidate,
        emailMetadata: { subject, from, date },
      });
      if (inserted) count += 1;
    }
  }
  return count;
}

async function insertGmailAttachmentReceipt(input: {
  connectionId: string;
  businessId?: string;
  messageId: string;
  attachment: GmailAttachmentCandidate;
  buffer: Buffer;
  emailMetadata: Record<string, string | undefined>;
}): Promise<boolean> {
  const existing = await db.query.receipts.findFirst({
    where: and(
      eq(receipts.gmailMessageId, input.messageId),
      eq(receipts.gmailAttachmentId, input.attachment.attachmentId),
    ),
  });
  if (existing) return false;

  const fileName = sanitizeFileName(input.attachment.filename);
  const key = `receipts/gmail/${input.connectionId}/${input.messageId}/${fileName}`;
  await storage().put({ key, body: input.buffer, contentType: input.attachment.mimeType });
  const [receipt] = await db.insert(receipts).values({
    businessId: input.businessId,
    source: 'gmail',
    status: 'pending',
    fileKey: key,
    fileName,
    mimeType: input.attachment.mimeType,
    gmailMessageId: input.messageId,
    gmailAttachmentId: input.attachment.attachmentId,
    ocrJson: {
      ...input.emailMetadata,
      contentKind: 'attachment',
    },
  }).returning({ id: receipts.id });
  await enqueue('receipt.extract', { receiptId: receipt.id });
  return true;
}

async function insertGmailBodyReceipt(input: {
  connectionId: string;
  businessId?: string;
  messageId: string;
  bodyCandidate: GmailBodyCandidate;
  emailMetadata: Record<string, string | undefined>;
}): Promise<boolean> {
  const bodyPartId = 'body';
  const existing = await db.query.receipts.findFirst({
    where: and(
      eq(receipts.gmailMessageId, input.messageId),
      eq(receipts.gmailAttachmentId, bodyPartId),
    ),
  });
  if (existing) return false;

  const buffer = Buffer.from(input.bodyCandidate.text, 'utf8');
  const key = `receipts/gmail/${input.connectionId}/${input.messageId}/${input.bodyCandidate.filename}`;
  await storage().put({ key, body: buffer, contentType: input.bodyCandidate.mimeType });
  const [receipt] = await db.insert(receipts).values({
    businessId: input.businessId,
    source: 'gmail',
    status: 'pending',
    fileKey: key,
    fileName: input.bodyCandidate.filename,
    mimeType: input.bodyCandidate.mimeType,
    gmailMessageId: input.messageId,
    gmailAttachmentId: bodyPartId,
    ocrJson: {
      ...input.emailMetadata,
      contentKind: 'email_body',
      bodyLength: input.bodyCandidate.bodyLength,
      truncated: input.bodyCandidate.truncated,
    },
  }).returning({ id: receipts.id });
  await enqueue('receipt.extract', { receiptId: receipt.id });
  return true;
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
