import crypto from 'node:crypto';
import { getEnv } from '../config/env.js';

export const DEFAULT_TRANSACTION_DETAIL_LIMIT = 100;
export const EXPANDED_TRANSACTION_DETAIL_LIMIT = 1000;
export const ASSISTANT_MUTATION_LIMIT = 50;

export type AssistantTokenPayload =
  | {
      kind: 'data_expansion';
      requestedLimit: number;
      purpose: string;
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
    };

interface AssistantTokenEnvelope {
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
    if (new Date(parsed.expiresAt).getTime() <= now.getTime()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isDangerousAssistantPrompt(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    'api key',
    'plaid secret',
    'encrypted access token',
    'session secret',
    'password hash',
    'full account number',
    'routing number',
    'raw plaid payload',
    'raw transaction json',
  ].some((term) => normalized.includes(term));
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (typeof inner === 'string' && /sk-[a-z0-9]/i.test(inner)) return '[redacted]';
    return inner;
  });
}

function defaultSecret(): string {
  return getEnv().SESSION_SECRET;
}
