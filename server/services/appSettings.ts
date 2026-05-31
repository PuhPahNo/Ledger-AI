import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appSettings } from '../db/schema.js';

/** Earliest date for which we expect receipts. Spend before this is treated as 'waived'. */
export const RECEIPT_TRACKING_SINCE = 'receipt_tracking_since';

export async function getSetting(key: string): Promise<string | null> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, key) });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

export function getReceiptTrackingSince(): Promise<string | null> {
  return getSetting(RECEIPT_TRACKING_SINCE);
}

export function setReceiptTrackingSince(date: string): Promise<void> {
  return setSetting(RECEIPT_TRACKING_SINCE, date);
}
