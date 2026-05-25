import type { AssistantApprovalRequest, AssistantResponse, AssistantToolEvent } from '@/types/domain';
import { API_BASE, http, useMockApi } from './client';

export type AssistantStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'tool_event'; event: AssistantToolEvent }
  | { type: 'approval'; approval: AssistantApprovalRequest }
  | { type: 'final'; response: AssistantResponse };

export interface SendAssistantMessageInput {
  message: string;
  previousResponseId?: string | null;
  approvedDataToken?: string | null;
}

export async function sendAssistantMessage(
  input: SendAssistantMessageInput,
  onEvent: (event: AssistantStreamEvent) => void,
): Promise<AssistantResponse> {
  if (useMockApi) return mockAssistantMessage(input, onEvent);
  const response = await fetch(`${API_BASE}/assistant/message`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, stream: true }),
  });
  if (!response.ok || !response.body) {
    const message = await response.text().catch(() => 'Assistant request failed');
    throw new Error(message || 'Assistant request failed');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: AssistantResponse | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as AssistantStreamEvent;
      onEvent(event);
      if (event.type === 'final') finalResponse = event.response;
    }
  }
  if (buffer.trim()) {
    const event = JSON.parse(buffer) as AssistantStreamEvent;
    onEvent(event);
    if (event.type === 'final') finalResponse = event.response;
  }
  if (!finalResponse) throw new Error('Assistant did not return a final response.');
  return finalResponse;
}

export function confirmAssistantAction(token: string): Promise<{ ok: boolean; message: string; artifact?: AssistantResponse['artifacts'][number] }> {
  if (useMockApi) {
    return Promise.resolve({
      ok: true,
      message: 'Mock action confirmed.',
      artifact: {
        type: 'table',
        id: `mock-confirm-${Date.now()}`,
        title: 'Confirmed mock action',
        columns: [{ key: 'status', label: 'Status' }],
        rows: [{ status: 'Applied in mock mode' }],
      },
    });
  }
  return http('/assistant/actions/confirm', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

async function mockAssistantMessage(
  input: SendAssistantMessageInput,
  onEvent: (event: AssistantStreamEvent) => void,
): Promise<AssistantResponse> {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  onEvent({ type: 'status', message: 'Reading your question and choosing Ledger AI tools.' });
  await wait(250);
  const tool: AssistantToolEvent = { name: 'get_cash_flow', status: 'called', detail: 'Calling cash-flow report.' };
  const finishedTool: AssistantToolEvent = { ...tool, status: 'succeeded', detail: 'Finished cash-flow report.' };
  onEvent({ type: 'tool_event', event: tool });
  await wait(450);
  onEvent({ type: 'tool_event', event: finishedTool });
  await wait(250);
  const wantsApproval = /100|500|all rows|all .*transactions|everything|export/i.test(input.message);
  const approval: AssistantApprovalRequest = {
    id: 'mock-approval',
    kind: wantsApproval ? 'data_expansion' : 'mutation',
    title: wantsApproval ? 'Approve expanded transaction detail' : 'Confirm transaction update',
    detail: wantsApproval
      ? 'This mock request asks for more than 100 sanitized rows.'
      : 'Apply the proposed mock categorization update.',
    token: 'mock-token',
    buttonLabel: wantsApproval ? 'Allow expanded rows' : 'Apply update',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
  const response: AssistantResponse = {
    answer: wantsApproval
      ? '**I can do that**, but I need approval before sharing expanded transaction detail with OpenAI. The default cap is 100 sanitized rows.'
      : '**Draft Sharks operating cash flow** improved month over month. In mock data, inflow is ahead of operating outflow, while transfers stay excluded by default.',
    artifacts: [
      {
        type: 'metric_grid',
        id: 'mock-metrics',
        title: 'Mock finance snapshot',
        metrics: [
          { label: 'Inflow', value: '$96,000', detail: 'May mock data', tone: 'positive' },
          { label: 'Operating outflow', value: '$82,000', detail: 'Transfers excluded', tone: 'default' },
          { label: 'Net', value: '$14,000', detail: 'Cash basis', tone: 'positive' },
        ],
      },
      {
        type: 'chart',
        id: 'mock-chart',
        title: 'Mock cash flow',
        chartType: 'bar',
        valueType: 'currency_cents',
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'],
        series: [
          { name: 'Inflow', color: '#1F8A5B', values: [8400000, 8900000, 138811900, 8200000, 9600000] },
          { name: 'Outflow', color: '#D97757', values: [6600000, 7100000, 6800000, 7800000, 8200000] },
        ],
      },
    ],
    approvalRequests: wantsApproval ? [approval] : [],
    followUpSuggestions: ['Show largest Draft Sharks entertainment purchases', 'Compare March 2026 to March 2025'],
    toolEvents: [tool, finishedTool],
    nextResponseId: 'mock-response-id',
  };
  onEvent({ type: 'final', response });
  return response;
}
