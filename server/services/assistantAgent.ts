import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { getEnv } from '../config/env.js';
import {
  assistantApiResponseSchema,
  assistantStructuredOutputSchema,
  sanitizeAssistantOutput,
  type AssistantApiResponse,
  type AssistantApprovalRequest,
  type AssistantToolEvent,
} from './assistantSchemas.js';
import { isDangerousAssistantPrompt, safeJson, verifyAssistantToken } from './assistantSecurity.js';
import { trackOpenAiCall } from './aiUsageTelemetry.js';
import {
  assistantToolDefinitions,
  callAssistantTool,
  toolEventDetail,
  type AssistantToolContext,
} from './assistantTools.js';

export type AssistantStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'tool_event'; event: AssistantToolEvent }
  | { type: 'approval'; approval: AssistantApprovalRequest }
  | { type: 'final'; response: AssistantApiResponse };

export interface RunAssistantInput {
  message: string;
  previousResponseId?: string | null;
  approvedDataToken?: string | null;
  context: AssistantToolContext;
  onEvent?: (event: AssistantStreamEvent) => void;
}

const instructions = [
  'You are Ledger AI Financial Assistant, a careful finance analysis agent inside Ledger AI.',
  'Answer questions using the provided Ledger AI tools; do not invent figures.',
  'Use operating cash-flow by default: exclude transfers unless the user asks for all movement.',
  'State important data limits when relevant: cash-basis Plaid transactions, no historical balance snapshots, and current balances only.',
  'Never ask for or reveal secrets, API keys, auth/session data, encrypted tokens, raw Plaid payloads, raw receipt files, routing numbers, or full account numbers.',
  'For transaction detail, prefer aggregates first. If a tool says expanded approval is required, explain the approval clearly and stop.',
  'For data changes, propose the change through tools; never claim a mutation happened unless a confirmation result says it did.',
  'For receipt pairing, inspect safe receipt rows and transaction candidates, then propose a receipt update or pairing. Never pair, dismiss, or edit a receipt without a user approval card.',
  'Do not edit bank transaction amounts. If OCR read the wrong amount, correct the receipt total before proposing the pairing.',
  'Use short, polished prose. Markdown emphasis is allowed; the client will render it as rich text.',
  'For table artifacts, put display values in each row as ordered string cells matching the column order.',
  'Return only the required structured output object.',
].join('\n');

export async function runAssistantMessage(input: RunAssistantInput): Promise<AssistantApiResponse> {
  const toolEvents: AssistantToolEvent[] = [];
  const approvals: AssistantApprovalRequest[] = [];
  const expandedDataApproved = Boolean(
    input.approvedDataToken
    && verifyAssistantToken(input.approvedDataToken, input.context.user.id)?.payload.kind === 'data_expansion',
  );
  const context = { ...input.context, expandedDataApproved };

  const emit = (event: AssistantStreamEvent) => input.onEvent?.(event);
  emit({ type: 'status', message: 'Reading your question and choosing the right Ledger AI tools.' });

  if (isDangerousAssistantPrompt(input.message)) {
    const response = assistantApiResponseSchema.parse({
      answer: 'I can help analyze your finances, but I cannot reveal secrets, raw provider payloads, full account numbers, routing numbers, or authentication data.',
      artifacts: [],
      approvalRequests: [],
      followUpSuggestions: ['Ask for safe account balances', 'Ask for transaction totals by business'],
      toolEvents,
      nextResponseId: null,
    });
    emit({ type: 'final', response });
    return response;
  }

  const env = getEnv();
  if (!env.OPENAI_API_KEY) {
    const response = assistantApiResponseSchema.parse({
      answer: 'OpenAI is not configured on this server yet, so the assistant cannot run live analysis.',
      artifacts: [],
      approvalRequests: [],
      followUpSuggestions: [],
      toolEvents,
      nextResponseId: null,
    });
    emit({ type: 'final', response });
    return response;
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  let previousResponseId = input.previousResponseId || undefined;
  let response: any = await trackOpenAiCall(
    'assistant',
    env.OPENAI_ASSISTANT_MODEL,
    () => client.responses.parse({
      model: env.OPENAI_ASSISTANT_MODEL,
      instructions,
      previous_response_id: previousResponseId,
      reasoning: { effort: env.OPENAI_ASSISTANT_REASONING_EFFORT },
      tools: assistantToolDefinitions,
      input: input.message,
      text: { format: zodTextFormat(assistantStructuredOutputSchema, 'ledger_ai_assistant_response') },
    } as any),
  );
  previousResponseId = response.id;

  for (let step = 0; step < 6; step += 1) {
    const calls = functionCalls(response);
    if (calls.length === 0) break;
    const outputs: Array<{
      type: 'function_call_output';
      call_id: string;
      output: string;
    }> = [];
    for (const call of calls) {
      const called = { name: call.name, status: 'called' as const, detail: toolEventDetail(call.name, 'called') };
      toolEvents.push(called);
      emit({ type: 'tool_event', event: called });
      const args = parseToolArguments(call.arguments);
      const result = await callAssistantTool(call.name, args, context);
      for (const approval of result.approvalRequests ?? []) {
        approvals.push(approval);
        emit({ type: 'approval', approval });
      }
      const completed = {
        name: call.name,
        status: result.ok ? 'succeeded' as const : 'failed' as const,
        detail: result.ok ? toolEventDetail(call.name, 'succeeded') : result.message,
      };
      toolEvents.push(completed);
      emit({ type: 'tool_event', event: completed });
      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: safeJson({
          ok: result.ok,
          message: result.message,
          data: result.data,
          artifacts: result.artifacts,
          approvalRequests: result.approvalRequests,
        }),
      });
    }
    emit({ type: 'status', message: 'Using the Ledger AI results to write the response.' });
    response = await trackOpenAiCall(
      'assistant',
      env.OPENAI_ASSISTANT_MODEL,
      () => client.responses.parse({
        model: env.OPENAI_ASSISTANT_MODEL,
        instructions,
        previous_response_id: previousResponseId,
        reasoning: { effort: env.OPENAI_ASSISTANT_REASONING_EFFORT },
        tools: assistantToolDefinitions,
        input: outputs,
        text: { format: zodTextFormat(assistantStructuredOutputSchema, 'ledger_ai_assistant_response') },
      } as any),
    );
    previousResponseId = response.id;
  }

  const structured = readStructuredOutput(response);
  const finalResponse = assistantApiResponseSchema.parse({
    ...structured,
    approvalRequests: [...(structured.approvalRequests ?? []), ...approvals],
    toolEvents,
    nextResponseId: previousResponseId ?? null,
  });
  emit({ type: 'final', response: finalResponse });
  return finalResponse;
}

function functionCalls(response: any): Array<{ name: string; arguments: string; call_id: string }> {
  return (response.output ?? [])
    .filter((item: any) => item?.type === 'function_call' && item.name && item.call_id)
    .map((item: any) => ({
      name: String(item.name),
      arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
      call_id: String(item.call_id),
    }));
}

function parseToolArguments(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function readStructuredOutput(response: any) {
  for (const item of response.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content?.type === 'output_text' && content.parsed) return sanitizeAssistantOutput(content.parsed);
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        try {
          return sanitizeAssistantOutput(JSON.parse(content.text));
        } catch {
          return sanitizeAssistantOutput({
            answer: content.text,
            artifacts: [],
            approvalRequests: [],
            followUpSuggestions: [],
          });
        }
      }
    }
  }
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    try {
      return sanitizeAssistantOutput(JSON.parse(response.output_text));
    } catch {
      return sanitizeAssistantOutput({
        answer: response.output_text,
        artifacts: [],
        approvalRequests: [],
        followUpSuggestions: [],
      });
    }
  }
  return sanitizeAssistantOutput({
    answer: 'I could not produce a complete answer. Try asking again with a narrower question.',
    artifacts: [],
    approvalRequests: [],
    followUpSuggestions: [],
  });
}
