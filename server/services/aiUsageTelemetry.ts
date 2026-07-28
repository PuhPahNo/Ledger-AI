import { gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiUsageEvents } from '../db/schema.js';

export type AiWorkload =
  | 'categorization_base'
  | 'categorization_web'
  | 'receipt_extraction'
  | 'receipt_category_evidence'
  | 'assistant';

export interface AiUsageEvent {
  workload: AiWorkload;
  model: string;
  responseId: string | null;
  status: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  webSearchCalls: number;
  errorCode: string | null;
}

export function extractAiUsageEvent(
  workload: AiWorkload,
  model: string,
  response: unknown,
): AiUsageEvent {
  const record = asRecord(response);
  const usage = asRecord(record.usage);
  const inputDetails = asRecord(usage.input_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details);
  const output = Array.isArray(record.output) ? record.output : [];
  const webSearchCalls = output.filter((item) => asRecord(item).type === 'web_search_call').length;

  return {
    workload,
    model,
    responseId: typeof record.id === 'string' ? record.id : null,
    status: typeof record.status === 'string' ? record.status : 'completed',
    inputTokens: integer(usage.input_tokens),
    cachedInputTokens: integer(inputDetails.cached_tokens),
    outputTokens: integer(usage.output_tokens),
    reasoningTokens: integer(outputDetails.reasoning_tokens),
    totalTokens: integer(usage.total_tokens),
    webSearchCalls,
    errorCode: null,
  };
}

export async function trackOpenAiCall<T>(
  workload: AiWorkload,
  model: string,
  request: () => Promise<T>,
): Promise<T> {
  try {
    const response = await request();
    await recordAiUsage(extractAiUsageEvent(workload, model, response));
    return response;
  } catch (error) {
    await recordAiUsage({
      workload,
      model,
      responseId: responseIdFromError(error),
      status: 'failed',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      webSearchCalls: 0,
      errorCode: errorCode(error),
    });
    throw error;
  }
}

export async function getAiUsageSummary(days = 30) {
  const safeDays = Math.max(1, Math.min(365, Math.trunc(days)));
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  return db
    .select({
      workload: aiUsageEvents.workload,
      model: aiUsageEvents.model,
      requests: sql<number>`count(*)::int`,
      failedRequests: sql<number>`count(*) filter (where ${aiUsageEvents.status} = 'failed')::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)::int`,
      cachedInputTokens: sql<number>`coalesce(sum(${aiUsageEvents.cachedInputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)::int`,
      reasoningTokens: sql<number>`coalesce(sum(${aiUsageEvents.reasoningTokens}), 0)::int`,
      totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)::int`,
      webSearchCalls: sql<number>`coalesce(sum(${aiUsageEvents.webSearchCalls}), 0)::int`,
    })
    .from(aiUsageEvents)
    .where(gte(aiUsageEvents.createdAt, since))
    .groupBy(aiUsageEvents.workload, aiUsageEvents.model)
    .orderBy(aiUsageEvents.workload, aiUsageEvents.model);
}

async function recordAiUsage(event: AiUsageEvent): Promise<void> {
  try {
    await db.insert(aiUsageEvents).values(event);
  } catch {
    // Telemetry must never make a user-facing OpenAI workflow fail.
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function integer(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function errorCode(error: unknown): string {
  const record = asRecord(error);
  const parts = [
    typeof record.status === 'number' ? String(record.status) : null,
    typeof record.code === 'string' ? record.code : null,
    typeof record.name === 'string' ? record.name : null,
  ].filter((part): part is string => Boolean(part));
  return (parts.join(':') || 'openai_error').slice(0, 120);
}

function responseIdFromError(error: unknown): string | null {
  const record = asRecord(error);
  const responseId = record.request_id ?? record.requestId;
  return typeof responseId === 'string' ? responseId : null;
}
