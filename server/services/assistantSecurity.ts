import crypto from 'node:crypto';
import { getEnv } from '../config/env.js';

export const DEFAULT_TRANSACTION_DETAIL_LIMIT = 100;
export const EXPANDED_TRANSACTION_DETAIL_LIMIT = 1000;
export const ASSISTANT_MUTATION_LIMIT = 50;

export interface AssistantReceiptUpdatePayload {
  merchant?: string | null;
  totalCents?: number | null;
  receiptDate?: string | null;
}

export type AssistantTokenPayload =
  | {
      kind: 'data_expansion';
      requestedLimit: number;
      purpose: string;
      /** The user question this approval belongs to; replayed server-side when approved. */
      question?: string;
    }
  | {
      kind: 'transaction_update';
      transactionId: string;
      categoryId?: string | null;
      businessId?: string | null;
      note?: string | null;
    }
  | {
      kind: 'bulk_transaction_update';
      transactionIds: string[];
      categoryId?: string | null;
      businessId?: string | null;
      note?: string | null;
    }
  | {
      kind: 'category_rule';
      businessId?: string | null;
      categoryId: string;
      matchKind: string;
      pattern: string;
      priority: number;
    }
  | {
      kind: 'receipt_update';
      receiptId: string;
      updates: AssistantReceiptUpdatePayload;
    }
  | {
      kind: 'receipt_pairing';
      receiptId: string;
      transactionId: string;
      updates?: AssistantReceiptUpdatePayload;
    };

export interface AssistantTokenEnvelope {
  /** Unique token id; consumed exactly once (see assistantTokenStore). */
  jti: string;
  userId: string;
  expiresAt: string;
  payload: AssistantTokenPayload;
}

export function requestedTransactionLimit(requested: unknown, expandedApproved: boolean): number {
  const raw = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_TRANSACTION_DETAIL_LIMIT;
  const max = expandedApproved ? EXPANDED_TRANSACTION_DETAIL_LIMIT : DEFAULT_TRANSACTION_DETAIL_LIMIT;
  return Math.max(1, Math.min(raw, max));
}

export function needsExpandedDataApproval(requested: unknown, expandedApproved: boolean): boolean {
  return !expandedApproved
    && typeof requested === 'number'
    && Number.isFinite(requested)
    && requested > DEFAULT_TRANSACTION_DETAIL_LIMIT;
}

export function signAssistantToken(
  userId: string,
  payload: AssistantTokenPayload,
  expiresInMs = 15 * 60 * 1000,
  secret = defaultSecret(),
  now = new Date(),
): string {
  const envelope: AssistantTokenEnvelope = {
    jti: crypto.randomUUID(),
    userId,
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
    payload,
  };
  const body = Buffer.from(JSON.stringify(envelope)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyAssistantToken(
  token: string,
  userId: string,
  secret = defaultSecret(),
  now = new Date(),
): AssistantTokenEnvelope | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AssistantTokenEnvelope;
    if (parsed.userId !== userId) return null;
    if (typeof parsed.jti !== 'string' || !parsed.jti) return null;
    if (new Date(parsed.expiresAt).getTime() <= now.getTime()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Narrow guard for requests that are explicitly after credentials. The real protection is that
 * no assistant tool ever returns secrets (see safe*Row / listAccounts), plus output scrubbing
 * below. Ordinary finance vocabulary ("routing number", "account number", "token budget") is
 * allowed: the tools simply never have that data, and the model will say so.
 */
const credentialTerms = String.raw`(?:api[\s_-]?keys?|secret[\s_-]?keys?|client[\s_-]?secrets?|plaid[\s_-]?secrets?|(?:plaid\s+)?access[\s_-]?tokens?|session[\s_-]?(?:secrets?|cookies?|tokens?)|passwords|password[\s_-]?hash(?:es)?|totp[\s_-]?secrets?|2fa\s+secrets?|encryption[\s_-]?keys?|private[\s_-]?keys?|env(?:ironment)?\s+variables?|\.env\s+file)`;
const revealVerbs = String.raw`(?:show|reveal|print|dump|display|give|send|tell|list|leak|expose|output|return|what(?:'s|\s+is|\s+are))`;
const dangerousPromptPatterns = [
  new RegExp(`\\b${revealVerbs}\\b[^.?!\\n]{0,60}\\b${credentialTerms}\\b`, 'i'),
  /\bignore (?:all |your |the )?(?:previous|prior|above) instructions\b[^.?!\n]{0,80}\b(?:secret|key|token|password)/i,
];

export function isDangerousAssistantPrompt(message: string): boolean {
  return dangerousPromptPatterns.some((pattern) => pattern.test(message));
}

const secretKeyPattern = /^(?:token|access_?token|refresh_?token|api_?key|secret|client_?secret|password|password_?hash|totp_?secret|session_?secret|encrypted[a-z_]*|plaid_?access_?token)$/i;

const scrubRules: Array<[RegExp, string | ((match: string) => string)]> = [
  // OpenAI-style secret keys (sk-..., sk-proj-...).
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  // Plaid access / public / link / processor tokens: access-sandbox-xxxxxxxx-...
  [/\b(?:access|public|link|processor)-(?:sandbox|development|production)-[A-Za-z0-9-]{8,}/g, '[redacted]'],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  // Bearer credentials.
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [redacted]'],
  // otpauth:// TOTP provisioning URIs.
  [/otpauth:\/\/\S+/gi, '[redacted]'],
  // bcrypt / argon2 / scrypt password hashes.
  [/\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}/g, '[redacted]'],
  [/\$(?:argon2(?:id|i|d)|scrypt)\$[^\s"']+/g, '[redacted]'],
  // Long digit runs that look like full account / card numbers: keep only the last four.
  // Digits glued to letters, hyphens or other digits (UUID segments, ids) are left alone.
  [/(?<![\w-])\d(?:[ ]?\d){8,18}(?![\w-])/g, (match) => `••••${match.replace(/\D/g, '').slice(-4)}`],
];

/** Redact anything that looks like a credential or full account number from free text. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of scrubRules) {
    out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return out;
}

/** JSON-encode tool output for the model with secret-looking keys and values scrubbed. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, (key, inner) => {
    if (key && secretKeyPattern.test(key)) return '[redacted]';
    if (typeof inner === 'string') return scrubSecrets(inner);
    return inner;
  });
}

function defaultSecret(): string {
  return getEnv().SESSION_SECRET;
}
