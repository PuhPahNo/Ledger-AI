import { describe, expect, it } from 'vitest';
import { extractAiUsageEvent } from './aiUsageTelemetry.js';

describe('extractAiUsageEvent', () => {
  it('records token details and actual web-search tool calls without prompt contents', () => {
    expect(extractAiUsageEvent('categorization_web', 'gpt-4.1-mini', {
      id: 'resp_123',
      status: 'completed',
      usage: {
        input_tokens: 240,
        input_tokens_details: { cached_tokens: 100 },
        output_tokens: 35,
        output_tokens_details: { reasoning_tokens: 4 },
        total_tokens: 275,
      },
      output: [
        { type: 'web_search_call' },
        { type: 'message', content: [{ type: 'output_text', text: 'private prompt output' }] },
      ],
    })).toEqual({
      workload: 'categorization_web',
      model: 'gpt-4.1-mini',
      responseId: 'resp_123',
      status: 'completed',
      inputTokens: 240,
      cachedInputTokens: 100,
      outputTokens: 35,
      reasoningTokens: 4,
      totalTokens: 275,
      webSearchCalls: 1,
      errorCode: null,
    });
  });

  it('defaults missing optional usage fields to zero', () => {
    expect(extractAiUsageEvent('assistant', 'gpt-test', {})).toMatchObject({
      status: 'completed',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      webSearchCalls: 0,
    });
  });
});
