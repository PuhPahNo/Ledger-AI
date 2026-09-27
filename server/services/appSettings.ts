import { eq, sql } from 'drizzle-orm';
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

export interface DailyCounter {
  date: string;
  calls: number;
}

export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Parse a stored `{"date","calls"}` counter; anything stale or corrupt reads as zero today. */
export function parseDailyCounter(raw: string | null, today: string): DailyCounter {
  try {
    const parsed = raw ? JSON.parse(raw) as { date?: unknown; calls?: unknown } : null;
    if (parsed?.date === today && typeof parsed.calls === 'number') return { date: today, calls: parsed.calls };
  } catch {
    // Corrupt value — treat as a fresh day.
  }
  return { date: today, calls: 0 };
}

export async function getDailyCounter(key: string): Promise<DailyCounter> {
  const today = todayUtc();
  return parseDailyCounter(await getSetting(key), today);
}

// Regex extraction (not a ::jsonb cast) so a corrupt stored value can never make the
// statement throw; it simply reads as "no calls today".
const storedDate = sql`substring(${appSettings.value} from '"date"[[:space:]]*:[[:space:]]*"([0-9-]+)"')`;
const storedCalls = sql`coalesce(substring(${appSettings.value} from '"calls"[[:space:]]*:[[:space:]]*([0-9]{1,9})')::int, 0)`;

/**
 * Atomically bump today's counter for `key` unless it is already at `limit`. A single
 * INSERT … ON CONFLICT DO UPDATE … WHERE, so concurrent workers can't both read N and
 * write N+1. Returns true when the call was reserved.
 */
export async function incrementDailyCounter(key: string, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const today = todayUtc();
  const fresh = JSON.stringify({ date: today, calls: 1 });
  const result = await db.execute(sql`
    INSERT INTO ${appSettings} (key, value, updated_at)
    VALUES (${key}, ${fresh}, now())
    ON CONFLICT (key) DO UPDATE SET
      value = json_build_object(
        'date', ${today}::text,
        'calls', CASE WHEN ${storedDate} = ${today}::text THEN ${storedCalls} + 1 ELSE 1 END
      )::text,
      updated_at = now()
    WHERE NOT (${storedDate} IS NOT DISTINCT FROM ${today}::text AND ${storedCalls} >= ${limit}::int)
    RETURNING key
  `);
  return (result.rowCount ?? result.rows.length) > 0;
}

/** Give back a reservation for a call that was never actually made. */
export async function decrementDailyCounter(key: string): Promise<void> {
  const today = todayUtc();
  await db.execute(sql`
    UPDATE ${appSettings}
    SET value = json_build_object('date', ${today}::text, 'calls', greatest(${storedCalls} - 1, 0))::text,
        updated_at = now()
    WHERE key = ${key} AND ${storedDate} = ${today}::text
  `);
}

// ---------------------------------------------------------------------------
// Categorization automation settings
// ---------------------------------------------------------------------------

export const AUTO_LEARN_MIN_CORRECTIONS = 'categorization_auto_learn_min_corrections';
export const EXTERNAL_SIGNAL_AUTO_APPLY_CONFIDENCE = 'categorization_external_signal_auto_apply_confidence';

export interface AutomationSettings {
  /** Consistent manual corrections (distinct transactions) before a merchant rule is learned. */
  autoLearnMinCorrections: number;
  /** External signals (QuickBooks etc.) at or above this confidence apply without review. */
  externalSignalAutoApplyConfidence: number;
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  autoLearnMinCorrections: 2,
  externalSignalAutoApplyConfidence: 0.9,
};

export const AUTOMATION_SETTING_LIMITS = {
  autoLearnMinCorrections: { min: 1, max: 10 },
  externalSignalAutoApplyConfidence: { min: 0.5, max: 1 },
} as const;

/** Stored values are strings; anything missing, corrupt, or out of range falls back to the default. */
export function parseAutomationSettings(raw: {
  autoLearnMinCorrections?: string | null;
  externalSignalAutoApplyConfidence?: string | null;
}): AutomationSettings {
  const minCorrections = Number(raw.autoLearnMinCorrections);
  const confidence = Number(raw.externalSignalAutoApplyConfidence);
  const limits = AUTOMATION_SETTING_LIMITS;
  return {
    autoLearnMinCorrections: raw.autoLearnMinCorrections != null
      && Number.isInteger(minCorrections)
      && minCorrections >= limits.autoLearnMinCorrections.min
      && minCorrections <= limits.autoLearnMinCorrections.max
      ? minCorrections
      : DEFAULT_AUTOMATION_SETTINGS.autoLearnMinCorrections,
    externalSignalAutoApplyConfidence: raw.externalSignalAutoApplyConfidence != null
      && Number.isFinite(confidence)
      && confidence >= limits.externalSignalAutoApplyConfidence.min
      && confidence <= limits.externalSignalAutoApplyConfidence.max
      ? confidence
      : DEFAULT_AUTOMATION_SETTINGS.externalSignalAutoApplyConfidence,
  };
}

export async function getAutomationSettings(): Promise<AutomationSettings> {
  const [autoLearnMinCorrections, externalSignalAutoApplyConfidence] = await Promise.all([
    getSetting(AUTO_LEARN_MIN_CORRECTIONS),
    getSetting(EXTERNAL_SIGNAL_AUTO_APPLY_CONFIDENCE),
  ]);
  return parseAutomationSettings({ autoLearnMinCorrections, externalSignalAutoApplyConfidence });
}

export async function setAutomationSettings(input: Partial<AutomationSettings>): Promise<AutomationSettings> {
  if (input.autoLearnMinCorrections !== undefined) {
    await setSetting(AUTO_LEARN_MIN_CORRECTIONS, String(input.autoLearnMinCorrections));
  }
  if (input.externalSignalAutoApplyConfidence !== undefined) {
    await setSetting(EXTERNAL_SIGNAL_AUTO_APPLY_CONFIDENCE, String(input.externalSignalAutoApplyConfidence));
  }
  return getAutomationSettings();
}
