import { describe, expect, it } from 'vitest';
import * as server from '../../../server/services/receiptMatchThresholds';
import { AUTO_ATTACH_THRESHOLD, SUGGESTED_THRESHOLD, matchScoreTone } from './matchThresholds';

describe('receipt match thresholds', () => {
  it('mirror the server matching policy', () => {
    expect(AUTO_ATTACH_THRESHOLD).toBe(server.AUTO_ATTACH_THRESHOLD);
    expect(SUGGESTED_THRESHOLD).toBe(server.SUGGESTED_THRESHOLD);
  });

  it('tones scores by the same bars', () => {
    expect(matchScoreTone(server.AUTO_ATTACH_THRESHOLD)).toBe('success');
    expect(matchScoreTone(server.SUGGESTED_THRESHOLD)).toBe('warning');
    expect(matchScoreTone(server.SUGGESTED_THRESHOLD - 0.01)).toBe('muted');
  });
});
