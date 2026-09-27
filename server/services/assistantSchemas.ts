import { z } from 'zod';
import { scrubSecrets } from './assistantSecurity.js';

export const assistantToneSchema = z.enum(['default', 'positive', 'warning', 'muted', 'danger']);

export const assistantMetricSchema = z.object({
  label: z.string(),
  value: z.string(),
  detail: z.string().nullable(),
  tone: assistantToneSchema,
});

export const assistantChartSeriesSchema = z.object({
  name: z.string(),
  color: z.string().nullable(),
  values: z.array(z.number()),
});

const assistantTableColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  align: z.enum(['left', 'right']).default('left'),
});

const assistantTableRowSchema = z.object({
  cells: z.array(z.string()).max(8),
});
const assistantChartTypeSchema = z.enum(['bar', 'stacked_bar', 'line', 'donut']);
const assistantValueTypeSchema = z.enum(['currency_cents', 'count', 'percent']);
const assistantActionSchema = z.object({
  label: z.string(),
  view: z.enum(['dashboard', 'transactions', 'receipts', 'cash-flow', 'balances', 'insights', 'assistant', 'admin']),
  filters: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.boolean(), z.null()])).optional(),
});
const assistantSourceSchema = z.object({
  type: z.enum(['transactions', 'receipts', 'cash_flow', 'owner_insights']),
  ids: z.array(z.string()).optional(),
  filters: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.boolean(), z.null()])).optional(),
});
const artifactEvidenceShape = {
  actions: z.array(assistantActionSchema).max(6).optional(),
  sources: z.array(assistantSourceSchema).max(6).optional(),
};

export const assistantArtifactSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('metric_grid'),
    id: z.string(),
    title: z.string(),
    metrics: z.array(assistantMetricSchema).max(12),
    ...artifactEvidenceShape,
  }),
  z.object({
    type: z.literal('table'),
    id: z.string(),
    title: z.string(),
    columns: z.array(assistantTableColumnSchema).max(8),
    rows: z.array(assistantTableRowSchema).max(50),
    ...artifactEvidenceShape,
  }),
  z.object({
    type: z.literal('transactions'),
    id: z.string(),
    title: z.string(),
    rows: z.array(z.object({
      id: z.string(),
      date: z.string(),
      merchant: z.string(),
      business: z.string(),
      category: z.string(),
      account: z.string(),
      amountCents: z.number().int(),
      receiptStatus: z.string(),
    })).max(100),
    ...artifactEvidenceShape,
  }),
  z.object({
    type: z.literal('chart'),
    id: z.string(),
    title: z.string(),
    chartType: assistantChartTypeSchema,
    valueType: assistantValueTypeSchema,
    labels: z.array(z.string()).max(36),
    series: z.array(assistantChartSeriesSchema).max(8),
    ...artifactEvidenceShape,
  }),
]);

export const assistantApprovalSchema = z.object({
  id: z.string(),
  kind: z.enum(['data_expansion', 'mutation']),
  title: z.string(),
  detail: z.string(),
  token: z.string(),
  buttonLabel: z.string(),
  expiresAt: z.string(),
});

export const assistantToolEventSchema = z.object({
  name: z.string(),
  status: z.enum(['called', 'succeeded', 'failed']),
  detail: z.string(),
});

/**
 * What the model returns. The model never writes chart/table data: tools register server-built
 * artifacts with short ids (a1, a2, ...) and the model only picks which ones to show. Approval
 * cards are likewise attached by the server from tool results, never copied by the model.
 */
export const assistantStructuredOutputSchema = z.object({
  answer: z.string(),
  artifactIds: z.array(z.string()).max(8),
  followUpSuggestions: z.array(z.string()).max(4),
});

export type AssistantModelOutput = z.infer<typeof assistantStructuredOutputSchema>;

export const assistantOutputSchema = z.object({
  answer: z.string(),
  artifacts: z.array(assistantArtifactSchema).default([]),
  approvalRequests: z.array(assistantApprovalSchema).default([]),
  followUpSuggestions: z.array(z.string()).max(4).default([]),
});

export const assistantApiResponseSchema = assistantOutputSchema.extend({
  toolEvents: z.array(assistantToolEventSchema).default([]),
  nextResponseId: z.string().nullable().default(null),
});

export type AssistantArtifact = z.infer<typeof assistantArtifactSchema>;
export type AssistantApprovalRequest = z.infer<typeof assistantApprovalSchema>;
export type AssistantApiResponse = z.infer<typeof assistantApiResponseSchema>;
export type AssistantStructuredOutput = z.infer<typeof assistantOutputSchema>;
export type AssistantToolEvent = z.infer<typeof assistantToolEventSchema>;

const fallbackModelOutput: AssistantModelOutput = {
  answer: 'I could not safely format that response. Try asking again with a narrower finance question.',
  artifactIds: [],
  followUpSuggestions: [],
};

/** Validate the model's structured output and scrub anything secret-looking from its prose. */
export function sanitizeAssistantOutput(input: unknown): AssistantModelOutput {
  const parsed = assistantStructuredOutputSchema.safeParse(input);
  if (!parsed.success) {
    const answer = input && typeof input === 'object' && typeof (input as { answer?: unknown }).answer === 'string'
      ? (input as { answer: string }).answer
      : null;
    return answer ? { ...fallbackModelOutput, answer: scrubSecrets(answer) } : fallbackModelOutput;
  }
  return {
    answer: scrubSecrets(parsed.data.answer),
    artifactIds: parsed.data.artifactIds,
    followUpSuggestions: parsed.data.followUpSuggestions.map(scrubSecrets),
  };
}
