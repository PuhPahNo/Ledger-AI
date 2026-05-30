import { describe, expect, it } from 'vitest';
import { isValidWebhookSecret } from './webhooks.js';

describe('webhook secret validation', () => {
  it('allows requests when no secret is configured', () => {
    expect(isValidWebhookSecret('', undefined)).toBe(true);
  });

  it('requires an exact configured secret match', () => {
    expect(isValidWebhookSecret('secret-token', 'secret-token')).toBe(true);
    expect(isValidWebhookSecret('secret-token', undefined)).toBe(false);
    expect(isValidWebhookSecret('secret-token', 'wrong-token')).toBe(false);
    expect(isValidWebhookSecret('secret-token', 'secret-token-extra')).toBe(false);
  });
});
