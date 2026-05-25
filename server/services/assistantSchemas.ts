import { z } from 'zod';

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

export const assistantArtifactSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('metric_grid'),
    id: z.string(),
    title: z.string(),
    metrics: z.array(assistantMetricSchema).max(12),
  }),
  z.object({
    type: z.literal('table'),
    id: z.string(),
    title: z.string(),
    columns: z.array(z.object({
      key: z.string(),
      label: z.string(),
      align: z.enum(['left', 'right']).default('left'),
    })).max(8),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(50),
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
  }),
  z.object({
    type: z.literal('chart'),
    id: z.string(),
    title: z.string(),
    chartType: z.enum(['bar', 'stacked_bar', 'line', 'donut']),
    valueType: z.enum(['currency_cents', 'count', 'percent']),
    labels: z.array(z.string()).max(36),
    series: z.array(assistantChartSeriesSchema).max(8),
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

export const assistantStructuredOutputSchema = z.object({
  answer: z.string(),
  artifacts: z.array(assistantArtifactSchema).default([]),
  approvalRequests: z.array(assistantApprovalSchema).default([]),
  followUpSuggestions: z.array(z.string()).max(4).default([]),
});

export const assistantApiResponseSchema = assistantStructuredOutputSchema.extend({
  toolEvents: z.array(assistantToolEventSchema).default([]),
  nextResponseId: z.string().nullable().default(null),
});

export type AssistantArtifact = z.infer<typeof assistantArtifactSchema>;
export type AssistantApprovalRequest = z.infer<typeof assistantApprovalSchema>;
export type AssistantApiResponse = z.infer<typeof assistantApiResponseSchema>;
export type AssistantStructuredOutput = z.infer<typeof assistantStructuredOutputSchema>;
export type AssistantToolEvent = z.infer<typeof assistantToolEventSchema>;

export function sanitizeAssistantOutput(input: unknown): AssistantStructuredOutput {
  const parsed = assistantStructuredOutputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  return {
    answer: 'I could not safely format that response. Try asking again with a narrower finance question.',
    artifacts: [],
    approvalRequests: [],
    followUpSuggestions: [],
  };
}
