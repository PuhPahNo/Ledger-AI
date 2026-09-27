import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8787),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  APP_ENCRYPTION_KEY: z.string().min(16),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
  PUBLIC_APP_URL: z.string().default('http://localhost:8787'),
  // Number of reverse-proxy hops in front of the app whose X-Forwarded-For entry is
  // trusted for request.ip (Render: 1). 0 disables proxy trust. Defaults to 1 in
  // production and 0 elsewhere.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
  RUN_WORKER_IN_WEB: z.enum(['true', 'false']).default('false'),
  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
  R2_ENDPOINT: z.string().optional().default(''),
  R2_BUCKET: z.string().optional().default(''),
  R2_ACCESS_KEY_ID: z.string().optional().default(''),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(''),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_ASSISTANT_MODEL: z.string().default('gpt-5.5'),
  OPENAI_ASSISTANT_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh']).default('medium'),
  OPENAI_RECEIPT_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_CATEGORIZATION_MODEL: z.string().default('gpt-4.1-mini'),
  // Keep hosted web search available as a second pass for merchants the base model
  // explicitly cannot identify. It is never exposed on the first-pass request.
  OPENAI_CATEGORIZATION_WEB_SEARCH: z.string().optional().default('true').transform((value) => value !== 'false'),
  // Hard ceilings on total categorization requests and the much more expensive web
  // subset. Over either cap, transactions stay uncategorized for a later scan.
  OPENAI_CATEGORIZATION_DAILY_LIMIT: z.coerce.number().int().min(0).optional().default(200),
  OPENAI_CATEGORIZATION_DAILY_WEB_SEARCH_LIMIT: z.coerce.number().int().min(0).optional().default(10),
  PLAID_ENV: z.enum(['sandbox', 'development', 'production']).default('sandbox'),
  PLAID_CLIENT_ID: z.string().optional().default(''),
  PLAID_SECRET: z.string().optional().default(''),
  PLAID_WEBHOOK_URL: z.string().optional().default(''),
  // Optional shared secret: /webhooks/plaid accepts ?secret=<value> (configure the same
  // value in PLAID_WEBHOOK_URL). Independently, Plaid's signed Plaid-Verification JWT is
  // always accepted; in production with Plaid configured, one of the two is required.
  PLAID_WEBHOOK_SECRET: z.string().optional().default(''),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z.string().optional().default(''),
  GOOGLE_PUBSUB_TOPIC: z.string().optional().default(''),
  GOOGLE_PUBSUB_WEBHOOK_SECRET: z.string().optional().default(''),
  // QuickBooks Online (read-only). Leave CLIENT_ID/SECRET empty to keep the feature off
  // ("not configured"). REDIRECT_URI must exactly match the Intuit app's redirect URI.
  QUICKBOOKS_CLIENT_ID: z.string().optional().default(''),
  QUICKBOOKS_CLIENT_SECRET: z.string().optional().default(''),
  QUICKBOOKS_REDIRECT_URI: z.string().optional().default(''),
  QUICKBOOKS_ENV: z.enum(['sandbox', 'production']).default('production'),
  // Local-testing overrides (npm run qbo:mock): Accounting API base and OAuth base.
  QUICKBOOKS_API_BASE: z.string().optional().default(''),
  QUICKBOOKS_AUTH_BASE: z.string().optional().default(''),
  LEDGER_ADMIN_USERNAME: z.string().default('admin'),
  LEDGER_ADMIN_PASSWORD: z.string().default('change-me-before-production'),
});

export type Env = Omit<z.infer<typeof envSchema>, 'TRUST_PROXY_HOPS'> & { TRUST_PROXY_HOPS: number };

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid Ledger AI environment:\n${details}`);
  }
  cached = {
    ...parsed.data,
    TRUST_PROXY_HOPS: parsed.data.TRUST_PROXY_HOPS ?? (parsed.data.NODE_ENV === 'production' ? 1 : 0),
    LOCAL_STORAGE_DIR: path.resolve(parsed.data.LOCAL_STORAGE_DIR),
  };
  return cached;
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}
