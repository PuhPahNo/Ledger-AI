import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TOOL_ROUNDS, runAssistantMessage, type AssistantModelClient } from './assistantAgent.js';
import { confirmAssistantAction } from './assistantActions.js';
import { cashFlowChart } from './assistantArtifacts.js';
import { signAssistantToken } from './assistantSecurity.js';
import {
  createMemoryTokenStore,
  setAssistantTokenStore,
  type AssistantTokenStore,
} from './assistantTokenStore.js';
import type { AssistantToolResult } from './assistantToolTypes.js';

const user = { id: 'user-1', username: 'admin', displayName: 'Admin', role: 'admin' as const, totpEnabled: false };

function functionCallResponse(id: string, calls: Array<{ name: string; args?: unknown }>) {
  return {
    id,
    output: calls.map((call, index) => ({
      type: 'function_call',
      name: call.name,
      call_id: `${id}-call-${index}`,
      arguments: JSON.stringify(call.args ?? {}),
    })),
  };
}

function finalResponse(id: string, parsed: unknown) {
  return { id, output: [{ type: 'message', content: [{ type: 'output_text', parsed }] }] };
}

function scriptedClient(responses: unknown[]) {
  const requests: any[] = [];
  const client: AssistantModelClient = {
    responses: {
      parse: async (params: any) => {
        requests.push(params);
        const next = responses.shift();
        if (!next) throw new Error('unexpected model call');
        return next;
      },
    },
  };
  return { client, requests };
}

let previousStore: AssistantTokenStore;
beforeEach(() => {
  previousStore = setAssistantTokenStore(createMemoryTokenStore());
});
afterEach(() => {
  setAssistantTokenStore(previousStore);
});

describe('assistant artifact attachment', () => {
  it('shows only server-built tool artifacts the model references, never model-written data', async () => {
    const chart = cashFlowChart([{ label: 'Mar 2026', inflowCents: 138811900, outflowCents: 6800000, netCents: 132011900 }], false);
    const { client, requests } = scriptedClient([
      functionCallResponse('r1', [{ name: 'get_cash_flow' }]),
      finalResponse('r2', {
        answer: 'March inflow was strong.',
        // a2 does not exist; a model-invented artifact object must be ignored entirely.
        artifactIds: ['a1', 'a2', 'a1'],
        followUpSuggestions: [],
        artifacts: [{ type: 'chart', id: 'fake', title: 'Hallucinated', series: [{ name: 'x', values: [1] }] }],
      }),
    ]);
    const response = await runAssistantMessage({
      message: 'Compare March inflow',
      context: { user },
      client,
      callTool: async (): Promise<AssistantToolResult> => ({ ok: true, message: 'Calculated cash flow.', data: {}, artifacts: [chart] }),
    });

    expect(response.artifacts).toHaveLength(1);
    expect(response.artifacts[0]).toEqual(chart);
    expect(response.nextResponseId).toBe('r2');

    // The model only saw a ref + title for the artifact, not a request to reproduce its data.
    const toolOutput = JSON.parse(requests[1].input[0].output);
    expect(toolOutput.artifacts).toEqual([{ ref: 'a1', type: 'chart', title: chart.title }]);
  });

  it('attaches approval cards from tools without exposing tokens to the model', async () => {
    const approval = {
      id: 'approval-1',
      kind: 'mutation' as const,
      title: 'Confirm rule',
      detail: 'Create rule',
      token: 'secret-signed-token',
      buttonLabel: 'Create rule',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const { client, requests } = scriptedClient([
      functionCallResponse('r1', [{ name: 'propose_category_rule' }]),
      finalResponse('r2', { answer: 'Ready for your confirmation.', artifactIds: [], followUpSuggestions: [] }),
    ]);
    const response = await runAssistantMessage({
      message: 'Make a rule',
      context: { user },
      client,
      callTool: async () => ({ ok: true, message: 'Prepared.', approvalRequests: [approval] }),
    });
    expect(response.approvalRequests).toEqual([approval]);
    expect(requests[1].input[0].output).not.toContain('secret-signed-token');
  });

  it('asks for a final tool-free answer when the tool budget is exhausted', async () => {
    const loops = Array.from({ length: MAX_TOOL_ROUNDS }, (_, index) => functionCallResponse(`r${index}`, [{ name: 'list_businesses' }]));
    const { client, requests } = scriptedClient([
      ...loops,
      finalResponse('final', { answer: 'Here is what I found so far.', artifactIds: [], followUpSuggestions: [] }),
    ]);
    const response = await runAssistantMessage({
      message: 'Loop forever',
      context: { user },
      client,
      callTool: async () => ({ ok: true, message: 'Listed.', data: [] }),
    });
    expect(response.answer).toBe('Here is what I found so far.');
    const last = requests.at(-1);
    expect(last.tool_choice).toBe('none');
    expect(last.input.at(-1).role).toBe('user');
  });

  it('feeds confirmed action results into the next model turn', async () => {
    const { client, requests } = scriptedClient([
      finalResponse('r1', { answer: 'Noted.', artifactIds: [], followUpSuggestions: [] }),
    ]);
    await runAssistantMessage({
      message: 'How many rules do I have now?',
      previousResponseId: 'r0',
      actionResults: ['Confirmed category_rule: Category rule created.'],
      context: { user },
      client,
    });
    expect(requests[0].previous_response_id).toBe('r0');
    expect(requests[0].input[0].content).toContain('Category rule created.');
    expect(requests[0].input[1]).toEqual({ role: 'user', content: 'How many rules do I have now?' });
  });

  it('does not block routing-number questions', async () => {
    const { client, requests } = scriptedClient([
      finalResponse('r1', { answer: 'Routing numbers are not stored in Ledger AI.', artifactIds: [], followUpSuggestions: [] }),
    ]);
    const response = await runAssistantMessage({ message: 'What is our routing number?', context: { user }, client });
    expect(requests).toHaveLength(1);
    expect(response.answer).toBe('Routing numbers are not stored in Ledger AI.');
  });
});

describe('single-use approval tokens', () => {
  it('replays the bound question for an expanded-data approval exactly once', async () => {
    const token = signAssistantToken(user.id, {
      kind: 'data_expansion',
      requestedLimit: 500,
      purpose: 'test',
      question: 'List all 500 transactions from March',
    });
    const { client, requests } = scriptedClient([
      functionCallResponse('r1', [{ name: 'query_transactions', args: { limit: 500 } }]),
      finalResponse('r2', { answer: 'Here are the rows.', artifactIds: [], followUpSuggestions: [] }),
    ]);
    let sawExpanded = false;
    let sawQuestion: string | undefined;
    const first = await runAssistantMessage({
      message: 'some unrelated later message',
      approvedDataToken: token,
      context: { user },
      client,
      callTool: async (_name, _args, context) => {
        sawExpanded = Boolean(context.expandedDataApproved);
        sawQuestion = context.question;
        return { ok: true, message: 'ok' };
      },
    });
    expect(first.answer).toBe('Here are the rows.');
    expect(requests[0].input).toContain('List all 500 transactions from March');
    expect(requests[0].input).not.toContain('some unrelated later message');
    expect(sawExpanded).toBe(true);
    expect(sawQuestion).toBe('List all 500 transactions from March');

    const replay = await runAssistantMessage({ message: '', approvedDataToken: token, context: { user }, client });
    expect(replay.answer).toMatch(/already used/i);
    expect(requests).toHaveLength(2);
  });

  it('rejects a second confirmation of the same action token', async () => {
    // Model a successful first confirmation (double-click / second tab) by consuming the jti, then
    // confirm again: it must be rejected before any mutation runs.
    const token = signAssistantToken(user.id, {
      kind: 'category_rule',
      categoryId: '7dcf0e6e-b40f-4899-93f6-636112047e76',
      matchKind: 'merchant_contains',
      pattern: 'topgolf',
      priority: 10,
    });
    const store = createMemoryTokenStore();
    setAssistantTokenStore(store);
    const { verifyAssistantToken } = await import('./assistantSecurity.js');
    const envelope = verifyAssistantToken(token, user.id)!;
    expect(await store.consume(envelope)).toBe(true);

    await expect(confirmAssistantAction(token, { user })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('memory store consumes each jti once and can release it', async () => {
    const store = createMemoryTokenStore();
    const envelope = { jti: 'j1', userId: user.id, expiresAt: new Date().toISOString(), payload: { kind: 'data_expansion' as const, requestedLimit: 1, purpose: 'x' } };
    expect(await store.consume(envelope)).toBe(true);
    expect(await store.consume(envelope)).toBe(false);
    await store.release('j1');
    expect(await store.consume(envelope)).toBe(true);
  });

  it('rejects tokens without a jti (issued before single-use tokens)', async () => {
    const { verifyAssistantToken } = await import('./assistantSecurity.js');
    const crypto = await import('node:crypto');
    const body = Buffer.from(JSON.stringify({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payload: { kind: 'data_expansion', requestedLimit: 1, purpose: 'x' },
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', 'test-session-secret-that-is-long-enough').update(body).digest('base64url');
    expect(verifyAssistantToken(`${body}.${signature}`, user.id)).toBeNull();
  });
});
