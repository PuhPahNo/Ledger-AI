export type AppViewName = 'dashboard' | 'transactions' | 'receipts' | 'cash-flow' | 'balances' | 'insights' | 'assistant' | 'admin';

export type AssistantTone = 'default' | 'positive' | 'warning' | 'muted' | 'danger';

export interface AssistantMetric {
  label: string;
  value: string;
  detail: string | null;
  tone: AssistantTone;
}

export interface AssistantArtifactAction {
  label: string;
  view: AppViewName;
  filters?: Record<string, string | string[] | boolean | null>;
}

export interface AssistantArtifactSource {
  type: 'transactions' | 'receipts' | 'cash_flow' | 'owner_insights';
  ids?: string[];
  filters?: Record<string, string | string[] | boolean | null>;
}

interface AssistantArtifactEvidence {
  actions?: AssistantArtifactAction[];
  sources?: AssistantArtifactSource[];
}

export type AssistantArtifact =
  | {
      type: 'metric_grid';
      id: string;
      title: string;
      metrics: AssistantMetric[];
    } & AssistantArtifactEvidence
  | {
      type: 'table';
      id: string;
      title: string;
      columns: Array<{ key: string; label: string; align?: 'left' | 'right' }>;
      rows: Array<{ cells: string[] }>;
    } & AssistantArtifactEvidence
  | {
      type: 'transactions';
      id: string;
      title: string;
      rows: Array<{
        id: string;
        date: string;
        merchant: string;
        business: string;
        category: string;
        account: string;
        amountCents: number;
        receiptStatus: string;
      }>;
    } & AssistantArtifactEvidence
  | {
      type: 'chart';
      id: string;
      title: string;
      chartType: 'bar' | 'stacked_bar' | 'line' | 'donut';
      valueType: 'currency_cents' | 'count' | 'percent';
      labels: string[];
      /** color is a theme token name (e.g. "sage", "coral"); the client maps it to a CSS variable. */
      series: Array<{ name: string; color: string | null; values: number[] }>;
    } & AssistantArtifactEvidence;

export interface AssistantApprovalRequest {
  id: string;
  kind: 'data_expansion' | 'mutation';
  title: string;
  detail: string;
  token: string;
  buttonLabel: string;
  expiresAt: string;
}

export interface AssistantToolEvent {
  name: string;
  status: 'called' | 'succeeded' | 'failed';
  detail: string;
}

export interface AssistantResponse {
  answer: string;
  artifacts: AssistantArtifact[];
  approvalRequests: AssistantApprovalRequest[];
  followUpSuggestions: string[];
  toolEvents: AssistantToolEvent[];
  nextResponseId: string | null;
}

export interface AssistantConfirmResult {
  ok: boolean;
  message: string;
  artifact?: AssistantArtifact;
  /** Id of the consumed (single-use) approval. */
  actionId?: string;
  /** Summary to feed back to the model on the next turn so it knows the action happened. */
  contextNote?: string;
}

/** Window event fired after the assistant applies a confirmed change; data hooks should refetch. */
export const LEDGER_DATA_CHANGED_EVENT = 'ledger:data-changed';

export interface LedgerDataChangedDetail {
  source: 'assistant';
  kind: string;
}
