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

const assistantTableColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  align: z.enum(['left', 'right']).default('left'),
});

const assistantArtifactRowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
const assistantChartTypeSchema = z.enum(['bar', 'stacked_bar', 'line', 'donut']);
const assistantValueTypeSchema = z.enum(['currency_cents', 'count', 'percent']);

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
    columns: z.array(assistantTableColumnSchema).max(8),
    rows: z.array(assistantArtifactRowSchema).max(50),
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
    chartType: assistantChartTypeSchema,
    valueType: assistantValueTypeSchema,
    labels: z.array(z.string()).max(36),
    series: z.array(assistantChartSeriesSchema).max(8),
  }),
]);

const assistantStructuredArtifactSchema = z.object({
  type: z.enum(['metric_grid', 'table', 'transactions', 'chart']),
  id: z.string(),
  title: z.string(),
  metrics: z.array(assistantMetricSchema).max(12).nullable(),
  columns: z.array(assistantTableColumnSchema).max(8).nullable(),
  rows: z.array(assistantArtifactRowSchema).max(100).nullable(),
  chartType: assistantChartTypeSchema.nullable(),
  valueType: assistantValueTypeSchema.nullable(),
  labels: z.array(z.string()).max(36).nullable(),
  series: z.array(assistantChartSeriesSchema).max(8).nullable(),
}).superRefine((artifact, ctx) => {
  if (artifact.type === 'metric_grid' && !artifact.metrics) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['metrics'], message: 'Metric artifacts require metrics.' });
  }
  if (artifact.type === 'table' && (!artifact.columns || !artifact.rows)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rows'], message: 'Table artifacts require columns and rows.' });
  }
  if (artifact.type === 'transactions') {
    if (!artifact.rows) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rows'], message: 'Transaction artifacts require rows.' });
      return;
    }
    artifact.rows.forEach((row, index) => {
      const hasRequiredShape = typeof row.id === 'string'
        && typeof row.date === 'string'
        && typeof row.merchant === 'string'
        && typeof row.business === 'string'
        && typeof row.category === 'string'
        && typeof row.account === 'string'
        && typeof row.amountCents === 'number'
        && typeof row.receiptStatus === 'string';
      if (!hasRequiredShape) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rows', index],
          message: 'Transaction rows require id, date, merchant, business, category, account, amountCents, and receiptStatus.',
        });
      }
    });
  }
  if (artifact.type === 'chart' && (!artifact.chartType || !artifact.valueType || !artifact.labels || !artifact.series)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['series'], message: 'Chart artifacts require chartType, valueType, labels, and series.' });
  }
});

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
  artifacts: z.array(assistantStructuredArtifactSchema).default([]),
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
