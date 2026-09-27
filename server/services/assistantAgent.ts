import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { getEnv } from '../config/env.js';
import {
  assistantApiResponseSchema,
  assistantStructuredOutputSchema,
  sanitizeAssistantOutput,
  type AssistantApiResponse,
  type AssistantApprovalRequest,
  type AssistantArtifact,
  type AssistantModelOutput,
  type AssistantToolEvent,
} from './assistantSchemas.js';
import { isDangerousAssistantPrompt, safeJson, scrubSecrets, verifyAssistantToken } from './assistantSecurity.js';
import { assistantTokenStore } from './assistantTokenStore.js';
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

/** Minimal slice of the OpenAI client the agent uses; injectable for tests and evals. */
export interface AssistantModelClient {
  responses: { parse: (params: any) => Promise<any> };
}

export interface RunAssistantInput {
  message: string;
  previousResponseId?: string | null;
  approvedDataToken?: string | null;
  /** Results of actions the user confirmed since the last model turn (from /assistant/actions/confirm). */
  actionResults?: string[];
  context: AssistantToolContext;
  onEvent?: (event: AssistantStreamEvent) => void;
  /** Overrides for evals/tests. */
  client?: AssistantModelClient;
  callTool?: typeof callAssistantTool;
}

export const MAX_TOOL_ROUNDS = 6;

export const assistantInstructions = [
  'You are Ledger AI Financial Assistant, a careful finance analysis agent inside Ledger AI.',
  'Answer questions using the provided Ledger AI tools; do not invent figures.',
  'Use operating cash-flow by default: exclude transfers unless the user asks for all movement.',
  'State important data limits when relevant: cash-basis Plaid transactions, no historical balance snapshots, and current balances only.',
  'Ledger AI never stores or exposes secrets, auth data, raw Plaid payloads, raw receipt files, routing numbers, or full account numbers (only masks). If asked for them, say they are not available here.',
  'For transaction detail, prefer aggregates first. If a tool says expanded approval is required, explain the approval clearly and stop.',
  'For data changes, propose the change through tools; never claim a mutation happened unless a confirmation result says it did. Approval cards are attached automatically; do not describe tokens.',
  'For receipt pairing, inspect safe receipt rows and transaction candidates, then propose a receipt update or pairing. Never pair, dismiss, or edit a receipt without a user approval card.',
  'Do not edit bank transaction amounts. If OCR read the wrong amount, correct the receipt total before proposing the pairing.',
  'Charts and tables: tool results list server-built artifacts as {ref, type, title}. To show one, put its ref (e.g. "a1") in artifactIds. Only the refs you list are shown, in that order; pick the ones that answer the question and skip redundant ones. You cannot create or edit chart/table data yourself.',
  'Use short, polished prose. Markdown emphasis and simple bullet lists are allowed.',
  'Return only the required structured output object.',
].join('\n');

const responseFormat = () => ({ format: zodTextFormat(assistantStructuredOutputSchema, 'ledger_ai_assistant_response') });

function simpleResponse(answer: string, extra: Partial<AssistantApiResponse> = {}): AssistantApiResponse {
  return assistantApiResponseSchema.parse({
    answer,
    artifacts: [],
    approvalRequests: [],
    followUpSuggestions: [],
    toolEvents: [],
    nextResponseId: null,
    ...extra,
  });
}

export async function runAssistantMessage(input: RunAssistantInput): Promise<AssistantApiResponse> {
  const toolEvents: AssistantToolEvent[] = [];
  const approvals: AssistantApprovalRequest[] = [];
  const artifactRegistry = new Map<string, AssistantArtifact>();
  const emit = (event: AssistantStreamEvent) => input.onEvent?.(event);
  const finish = (response: AssistantApiResponse) => {
    emit({ type: 'final', response });
    return response;
  };
  const keepConversation = { nextResponseId: input.previousResponseId ?? null };

  emit({ type: 'status', message: 'Reading your question and choosing the right Ledger AI tools.' });

  // An expanded-data approval is bound to the question it was issued for, and is single-use.
  let question = input.message.trim();
  let modelMessage = question;
  let expandedDataApproved = false;
  if (input.approvedDataToken) {
    const envelope = verifyAssistantToken(input.approvedDataToken, input.context.user.id);
    if (!envelope || envelope.payload.kind !== 'data_expansion') {
      return finish(simpleResponse('That approval expired or is invalid. Ask the question again and I will prepare a new one.', keepConversation));
    }
    if (!(await assistantTokenStore().consume(envelope))) {
      return finish(simpleResponse('That approval was already used.', keepConversation));
    }
    expandedDataApproved = true;
    question = envelope.payload.question?.trim() || question;
    if (!question) return finish(simpleResponse('I could not find the question this approval belongs to. Please ask it again.', keepConversation));
    modelMessage = [
      `The user approved expanded transaction detail (up to ${envelope.payload.requestedLimit} rows) for this earlier question.`,
      'Answer it now using the expanded limit:',
      question,
    ].join('\n');
  } else if (isDangerousAssistantPrompt(question)) {
    return finish(simpleResponse(
      'I can help analyze your finances, but I cannot reveal credentials such as API keys, access tokens, passwords, or session secrets. Ledger AI does not expose them to the assistant.',
      { followUpSuggestions: ['Show current account balances', 'Show transaction totals by business'], ...keepConversation },
    ));
  }
  if (!question) return finish(simpleResponse('Ask me a question about your finances.', keepConversation));

  const context: AssistantToolContext = { ...input.context, expandedDataApproved, question };
  const callTool = input.callTool ?? callAssistantTool;

  const env = getEnv();
  if (!input.client && !env.OPENAI_API_KEY) {
    return finish(simpleResponse('OpenAI is not configured on this server yet, so the assistant cannot run live analysis.'));
  }
  const client: AssistantModelClient = input.client ?? new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const model = env.OPENAI_ASSISTANT_MODEL;
  let previousResponseId = input.previousResponseId || undefined;

  const createResponse = async (modelInput: unknown, options: { final?: boolean } = {}) => {
    const params = {
      model,
      instructions: assistantInstructions,
      previous_response_id: previousResponseId,
      reasoning: { effort: env.OPENAI_ASSISTANT_REASONING_EFFORT },
      tools: assistantToolDefinitions,
      ...(options.final ? { tool_choice: 'none' } : {}),
      input: modelInput,
      text: responseFormat(),
    };
    const request = () => client.responses.parse(params);
    const result = input.client ? await request() : await trackOpenAiCall('assistant', model, request);
    previousResponseId = result.id ?? previousResponseId;
    return result;
  };

  const actionNotes = (input.actionResults ?? [])
    .slice(-10)
    .map((note) => scrubSecrets(String(note).slice(0, 600)).trim())
    .filter(Boolean);
  const initialInput = actionNotes.length
    ? [
        {
          role: 'user',
          content: [
            'Context from the Ledger AI app (not typed by the user): since your last reply the user acted on these approval cards. Treat confirmed items as already applied and declined items as not applied:',
            ...actionNotes.map((note) => `- ${note}`),
          ].join('\n'),
        },
        { role: 'user', content: modelMessage },
      ]
    : modelMessage;

  let response: any = await createResponse(initialInput);

  for (let round = 0; ; round += 1) {
    const calls = functionCalls(response);
    if (calls.length === 0) break;
    const outputs: Array<{ type: 'function_call_output'; call_id: string; output: string }> = [];
    for (const call of calls) {
      const called = { name: call.name, status: 'called' as const, detail: toolEventDetail(call.name, 'called') };
      toolEvents.push(called);
      emit({ type: 'tool_event', event: called });
      const result = await callTool(call.name, parseToolArguments(call.arguments), context);
      for (const approval of result.approvalRequests ?? []) {
        approvals.push(approval);
        emit({ type: 'approval', approval });
      }
      const artifactRefs = (result.artifacts ?? []).map((artifact) => {
        const ref = `a${artifactRegistry.size + 1}`;
        artifactRegistry.set(ref, artifact);
        return { ref, type: artifact.type, title: artifact.title };
      });
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
          artifacts: artifactRefs,
          // Cards are shown to the user by the server; the model only needs to know they exist.
          pendingApprovals: (result.approvalRequests ?? []).map((approval) => ({ title: approval.title, detail: approval.detail })),
        }),
      });
    }
    if (round + 1 >= MAX_TOOL_ROUNDS) {
      emit({ type: 'status', message: 'Tool budget reached. Writing the answer with the data gathered.' });
      response = await createResponse([
        ...outputs,
        {
          role: 'user',
          content: 'Tool budget reached (not typed by the user). Do not call more tools. Answer now using only the data already gathered, and say briefly what could not be checked.',
        },
      ], { final: true });
      break;
    }
    emit({ type: 'status', message: 'Using the Ledger AI results to write the response.' });
    response = await createResponse(outputs);
  }

  const structured = readStructuredOutput(response);
  const artifacts = [...new Set(structured.artifactIds)]
    .map((ref) => artifactRegistry.get(ref))
    .filter((artifact): artifact is AssistantArtifact => Boolean(artifact));
  return finish(assistantApiResponseSchema.parse({
    answer: structured.answer,
    artifacts,
    approvalRequests: approvals,
    followUpSuggestions: structured.followUpSuggestions,
    toolEvents,
    nextResponseId: previousResponseId ?? null,
  }));
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

function readStructuredOutput(response: any): AssistantModelOutput {
  const fromText = (text: string) => {
    try {
      return sanitizeAssistantOutput(JSON.parse(text));
    } catch {
      return sanitizeAssistantOutput({ answer: text, artifactIds: [], followUpSuggestions: [] });
    }
  };
  for (const item of response?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content?.type === 'output_text' && content.parsed) return sanitizeAssistantOutput(content.parsed);
      if (content?.type === 'output_text' && typeof content.text === 'string') return fromText(content.text);
    }
  }
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return fromText(response.output_text);
  return sanitizeAssistantOutput({
    answer: 'I could not produce a complete answer. Try asking again with a narrower question.',
    artifactIds: [],
    followUpSuggestions: [],
  });
}
