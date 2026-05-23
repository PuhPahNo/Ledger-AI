import { eq } from 'drizzle-orm';
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from 'plaid';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import { accounts, connections, transactions } from '../db/schema.js';
import { decryptText, encryptText } from '../lib/crypto.js';
import { categorizeTransaction } from './categorization.js';

export function plaidClient(): PlaidApi | null {
  const env = getEnv();
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) return null;
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env.PLAID_ENV],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
        'PLAID-SECRET': env.PLAID_SECRET,
      },
    },
  }));
}

export async function createPlaidLinkToken(userId: string): Promise<{ link_token: string; expiration: string }> {
  const client = plaidClient();
  if (!client) {
    return {
      link_token: 'development-plaid-link-token',
      expiration: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  }
  const env = getEnv();
  const res = await client.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'Ledger AI',
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: 'en',
    webhook: env.PLAID_WEBHOOK_URL || undefined,
  });
  return res.data;
}

export async function exchangePlaidPublicToken(input: {
  publicToken: string;
  businessId?: string;
}): Promise<string> {
  const client = plaidClient();
  if (!client) throw new Error('Plaid is not configured');
  const exchange = await client.itemPublicTokenExchange({ public_token: input.publicToken });
  const accessToken = exchange.data.access_token;
  const itemId = exchange.data.item_id;
  const item = await client.itemGet({ access_token: accessToken });
  const label = item.data.item.institution_id ?? 'Plaid connection';

  const [connection] = await db.insert(connections).values({
    businessId: input.businessId,
    kind: 'bank',
    label,
    status: 'live',
    providerItemId: itemId,
    encryptedAccessToken: encryptText(accessToken),
  }).returning();

  await syncPlaidConnection(connection.id);
  return connection.id;
}

export async function syncPlaidConnection(connectionId: string): Promise<number> {
  const client = plaidClient();
  if (!client) return 0;
  const connection = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
  if (!connection?.encryptedAccessToken) return 0;
  const accessToken = decryptText(connection.encryptedAccessToken);

  let cursor: string | undefined = connection.plaidCursor ?? undefined;
  let addedCount = 0;
  let hasMore = true;

  while (hasMore) {
    const res = await client.transactionsSync({
      access_token: accessToken,
      cursor,
      count: 500,
    });
    const data = res.data;
    await upsertAccounts(connectionId, connection.businessId ?? undefined, data.accounts ?? []);
    for (const txn of data.added ?? []) {
      await upsertTransaction(connectionId, connection.businessId ?? undefined, txn);
      addedCount += 1;
    }
    for (const txn of data.modified ?? []) {
      await upsertTransaction(connectionId, connection.businessId ?? undefined, txn);
    }
    for (const removed of data.removed ?? []) {
      await db.delete(transactions).where(eq(transactions.plaidTransactionId, removed.transaction_id));
    }
    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  await db.update(connections).set({
    plaidCursor: cursor,
    lastSyncAt: new Date(),
    syncedTransactionCount: (connection.syncedTransactionCount ?? 0) + addedCount,
    updatedAt: new Date(),
  }).where(eq(connections.id, connectionId));

  return addedCount;
}

async function upsertAccounts(connectionId: string, businessId: string | undefined, plaidAccounts: unknown[]): Promise<void> {
  for (const raw of plaidAccounts as Array<Record<string, any>>) {
    await db.insert(accounts).values({
      connectionId,
      businessId,
      plaidAccountId: raw.account_id,
      name: raw.name ?? raw.official_name ?? 'Account',
      officialName: raw.official_name,
      mask: raw.mask,
      kind: mapAccountKind(raw.type, raw.subtype),
      currentBalanceCents: raw.balances?.current != null ? Math.round(Number(raw.balances.current) * 100) : null,
      availableBalanceCents: raw.balances?.available != null ? Math.round(Number(raw.balances.available) * 100) : null,
    }).onConflictDoUpdate({
      target: accounts.plaidAccountId,
      set: {
        businessId,
        name: raw.name ?? raw.official_name ?? 'Account',
        officialName: raw.official_name,
        mask: raw.mask,
        kind: mapAccountKind(raw.type, raw.subtype),
        updatedAt: new Date(),
      },
    });
  }
}

async function upsertTransaction(connectionId: string, fallbackBusinessId: string | undefined, raw: Record<string, any>): Promise<void> {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.plaidAccountId, raw.account_id) });
  const businessId = account?.businessId ?? fallbackBusinessId;
  if (!businessId) return;
  const amountCents = -Math.round(Number(raw.amount) * 100);
  const categoryId = await categorizeTransaction({
    businessId,
    merchant: raw.merchant_name ?? raw.name ?? 'Unknown merchant',
    amountCents,
    plaidCategory: raw.category,
  });
  const sourceLabel = account ? `${account.name}${account.mask ? ` ${account.mask}` : ''}` : `Plaid ${connectionId.slice(0, 8)}`;

  await db.insert(transactions).values({
    businessId,
    accountId: account?.id,
    plaidTransactionId: raw.transaction_id,
    date: raw.date,
    authorizedDate: raw.authorized_date,
    merchant: raw.merchant_name ?? raw.name ?? 'Unknown merchant',
    amountCents,
    categoryId,
    receiptStatus: amountCents < 0 ? 'missing' : 'n/a',
    sourceLabel,
    pending: Boolean(raw.pending),
    raw,
  }).onConflictDoUpdate({
    target: transactions.plaidTransactionId,
    set: {
      date: raw.date,
      authorizedDate: raw.authorized_date,
      merchant: raw.merchant_name ?? raw.name ?? 'Unknown merchant',
      amountCents,
      categoryId,
      pending: Boolean(raw.pending),
      raw,
      updatedAt: new Date(),
    },
  });
}

function mapAccountKind(type?: string, subtype?: string): 'checking' | 'savings' | 'credit' | 'other' {
  if (type === 'credit') return 'credit';
  if (subtype === 'checking') return 'checking';
  if (subtype === 'savings') return 'savings';
  return 'other';
}
