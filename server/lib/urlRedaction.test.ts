import { describe, expect, it } from 'vitest';
import { redactSensitiveUrl } from './urlRedaction.js';

describe('redactSensitiveUrl', () => {
  it('redacts sensitive query params while keeping the route visible', () => {
    expect(redactSensitiveUrl('/api/webhooks/google/pubsub?secret=abc+123&x=1')).toBe('/api/webhooks/google/pubsub?secret=[redacted]&x=1');
  });

  it('leaves URLs without sensitive query params unchanged', () => {
    expect(redactSensitiveUrl('/api/receipts?status=pending')).toBe('/api/receipts?status=pending');
  });
});
