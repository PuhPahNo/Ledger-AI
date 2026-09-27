import { describe, expect, it } from 'vitest';
import {
  gmailHitStatus,
  latestPerReceipt,
  queueBlockedReason,
  recentMatchMode,
  shapeQueueCandidates,
} from './receiptWorkflow.js';

describe('shapeQueueCandidates', () => {
  const candidate = (id: string, score: number, rejected = false) => ({ id, score, rejected });

  it('returns the top three by score', () => {
    const shaped = shapeQueueCandidates([candidate('a', 0.4), candidate('b', 0.9), candidate('c', 0.7), candidate('d', 0.6)]);
    expect(shaped.map((row) => row.id)).toEqual(['b', 'c', 'd']);
  });

  it('drops pairs the user already rejected', () => {
    const shaped = shapeQueueCandidates([candidate('a', 0.99, true), candidate('b', 0.5), candidate('c', 0.3)]);
    expect(shaped.map((row) => row.id)).toEqual(['b', 'c']);
  });

  it('honours a custom limit and empty input', () => {
    expect(shapeQueueCandidates([candidate('a', 0.5), candidate('b', 0.4)], 1).map((row) => row.id)).toEqual(['a']);
    expect(shapeQueueCandidates([])).toEqual([]);
  });
});

describe('queueBlockedReason', () => {
  it('is null once total and date are known', () => {
    expect(queueBlockedReason({ totalCents: 100, receiptDate: '2026-09-01', extractionError: null, confidence: '0.9' })).toBeNull();
  });

  it('distinguishes extraction still running from details the user must type', () => {
    expect(queueBlockedReason({ totalCents: null, receiptDate: null, extractionError: null, confidence: null })).toBe('extraction_pending');
    expect(queueBlockedReason({ totalCents: null, receiptDate: '2026-09-01', extractionError: 'Could not read', confidence: '0.3' })).toBe('missing_details');
    expect(queueBlockedReason({ totalCents: 100, receiptDate: null, extractionError: null, confidence: '0.8' })).toBe('missing_details');
  });
});

describe('recent matches shaping', () => {
  it('maps match status to auto/manual', () => {
    expect(recentMatchMode('auto')).toBe('auto');
    expect(recentMatchMode('accepted')).toBe('manual');
  });

  it('keeps the latest decision per receipt, newest first', () => {
    const rows = latestPerReceipt([
      { receiptId: 'r1', decidedAt: new Date('2026-09-01T00:00:00Z'), tag: 'old' },
      { receiptId: 'r2', decidedAt: new Date('2026-09-03T00:00:00Z'), tag: 'r2' },
      { receiptId: 'r1', decidedAt: new Date('2026-09-05T00:00:00Z'), tag: 'new' },
    ]);
    expect(rows.map((row) => row.tag)).toEqual(['new', 'r2']);
  });
});

describe('gmailHitStatus', () => {
  const base = { status: 'pending' as const, transactionId: null, totalCents: 5499, receiptDate: '2026-09-10', extractionError: null, confidence: '0.9' };

  it('classifies hits relative to the searched transaction', () => {
    expect(gmailHitStatus({ ...base, status: 'matched', transactionId: 't1' }, 't1')).toBe('paired_here');
    expect(gmailHitStatus({ ...base, status: 'matched', transactionId: 't2' }, 't1')).toBe('paired_elsewhere');
    expect(gmailHitStatus({ ...base, status: 'n/a' }, 't1')).toBe('dismissed');
    expect(gmailHitStatus(base, 't1')).toBe('candidate');
    expect(gmailHitStatus({ ...base, totalCents: null, confidence: null }, 't1')).toBe('processing');
    expect(gmailHitStatus({ ...base, totalCents: null, extractionError: 'x' }, 't1')).toBe('needs_details');
  });
});
