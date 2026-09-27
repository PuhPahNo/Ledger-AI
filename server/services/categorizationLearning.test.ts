import { describe, expect, it } from 'vitest';
import {
  detectConsistentCorrections,
  feedbackRowToCorrection,
  isLearnableRuleCategory,
  planLearnedRuleUndo,
  planRuleUndo,
  type CorrectionRecord,
} from './categorizationLearning.js';

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute));
const human = (id: string, categoryId: string, minute: number, transactionIds = [`txn-${id}`]): CorrectionRecord => ({
  id, categoryId, transactionIds, createdAt: at(minute), human: true,
});

describe('detectConsistentCorrections', () => {
  it('learns after two matching corrections on distinct transactions', () => {
    const verdict = detectConsistentCorrections(
      [human('f1', 'meals', 1), human('f2', 'meals', 2)],
      { minCorrections: 2 },
    );
    expect(verdict).toEqual({
      learn: true,
      categoryId: 'meals',
      feedbackIds: ['f2', 'f1'],
      transactionIds: ['txn-f2', 'txn-f1'],
    });
  });

  it('a single correction only teaches the AI', () => {
    const verdict = detectConsistentCorrections([human('f1', 'meals', 1)], { minCorrections: 2 });
    expect(verdict.learn).toBe(false);
    expect(verdict).toMatchObject({ reason: 'not_enough_corrections', categoryId: 'meals' });
  });

  it('does not count the same transaction corrected twice as two corrections', () => {
    const verdict = detectConsistentCorrections(
      [human('f1', 'meals', 1, ['t1']), human('f2', 'meals', 2, ['t1'])],
      { minCorrections: 2 },
    );
    expect(verdict.learn).toBe(false);
  });

  it('a contradicting correction in between resets the streak', () => {
    const verdict = detectConsistentCorrections(
      [human('f1', 'meals', 1), human('f2', 'travel', 2), human('f3', 'meals', 3)],
      { minCorrections: 2 },
    );
    expect(verdict.learn).toBe(false);
    expect(verdict.transactionIds).toEqual(['txn-f3']);
  });

  it('learns the newest consistent category once the streak is long enough again', () => {
    const verdict = detectConsistentCorrections(
      [human('f1', 'meals', 1), human('f2', 'travel', 2), human('f3', 'travel', 3)],
      { minCorrections: 2 },
    );
    expect(verdict).toMatchObject({ learn: true, categoryId: 'travel', feedbackIds: ['f3', 'f2'] });
  });

  it('a bulk edit of two same-merchant rows counts as two corrections', () => {
    const verdict = detectConsistentCorrections([human('f1', 'meals', 1, ['t1', 't2'])], { minCorrections: 2 });
    expect(verdict.learn).toBe(true);
  });

  it('respects a configured threshold', () => {
    const records = [human('f1', 'meals', 1), human('f2', 'meals', 2)];
    expect(detectConsistentCorrections(records, { minCorrections: 3 }).learn).toBe(false);
  });

  it('confident external signals corroborate a human streak but never start one', () => {
    const external: CorrectionRecord = {
      id: 'x1', categoryId: 'meals', transactionIds: ['t9'], createdAt: at(5), human: false, confidence: 0.97,
    };
    expect(detectConsistentCorrections([external], { minCorrections: 1 }).learn).toBe(false);
    expect(detectConsistentCorrections([human('f1', 'meals', 1), external], { minCorrections: 2 }).learn).toBe(true);
    expect(detectConsistentCorrections(
      [human('f1', 'meals', 1), { ...external, confidence: 0.8 }],
      { minCorrections: 2 },
    ).learn).toBe(false);
  });

  it('ignores external signals from before a human contradiction', () => {
    const verdict = detectConsistentCorrections([
      { id: 'x1', categoryId: 'meals', transactionIds: ['t9'], createdAt: at(1), human: false, confidence: 0.99 },
      human('f2', 'travel', 2),
      human('f3', 'meals', 3),
    ], { minCorrections: 2 });
    expect(verdict.learn).toBe(false);
  });
});

describe('feedbackRowToCorrection', () => {
  const base = { id: 'f', newCategoryId: 'meals', transactionId: 't1', payload: {}, createdAt: at(1) };

  it('treats manual edits and accepted suggestions as human, external:* as corroboration', () => {
    expect(feedbackRowToCorrection({ ...base, source: 'manual' })?.human).toBe(true);
    expect(feedbackRowToCorrection({ ...base, source: 'ai_suggestion_accepted' })?.human).toBe(true);
    expect(feedbackRowToCorrection({ ...base, source: 'external:quickbooks', payload: { confidence: 0.96 } }))
      .toMatchObject({ human: false, confidence: 0.96 });
    expect(feedbackRowToCorrection({ ...base, source: 'something_else' })).toBeNull();
  });

  it('merges bulk transaction ids from the payload', () => {
    expect(feedbackRowToCorrection({ ...base, source: 'manual', payload: { transactionIds: ['t1', 't2'] } })?.transactionIds)
      .toEqual(['t1', 't2']);
  });
});

describe('isLearnableRuleCategory', () => {
  const spend = { id: 'c', businessId: null, name: 'Meals', taxCode: 'schedule_c_line_24b', active: true };
  it('only allows active spend categories usable by the business', () => {
    expect(isLearnableRuleCategory(spend, 'b1')).toBe(true);
    expect(isLearnableRuleCategory({ ...spend, active: false }, 'b1')).toBe(false);
    expect(isLearnableRuleCategory({ ...spend, businessId: 'b2' }, 'b1')).toBe(false);
    expect(isLearnableRuleCategory({ ...spend, name: 'Revenue', taxCode: 'income' }, 'b1')).toBe(false);
  });
});

describe('planLearnedRuleUndo', () => {
  const eventId = 'event-1';
  const relabel = (transactionId: string, previous: {
    categoryId: string | null; source: string; confidence: string | null; evidence: Record<string, unknown>;
  }) => ({
    id: `relabel-${transactionId}`,
    transactionId,
    previousCategoryId: previous.categoryId,
    previousCategorySource: previous.source as never,
    previousCategoryConfidence: previous.confidence,
    previousCategoryEvidence: previous.evidence,
    newCategoryId: 'meals',
    restoredAt: null,
  });
  const ruleState = { categoryId: 'meals', categorySource: 'user_confirmed_rule', categoryEvidence: { learningEventId: eventId } };

  it('restores the exact prior category, source, confidence and evidence', () => {
    const relabels = [
      relabel('t1', { categoryId: 'misc', source: 'ai_suggested', confidence: '0.9100', evidence: { reason: 'ai' } }),
      relabel('t2', { categoryId: 'uncat', source: 'uncategorized', confidence: null, evidence: {} }),
    ];
    const current = new Map([
      ['t1', { id: 't1', ...ruleState }],
      ['t2', { id: 't2', ...ruleState }],
    ]);
    const plan = planLearnedRuleUndo(eventId, relabels, current);
    expect(plan.skippedTransactionIds).toEqual([]);
    expect(plan.restore).toEqual([
      {
        relabelId: 'relabel-t1',
        transactionId: 't1',
        categoryId: 'misc',
        categorySource: 'ai_suggested',
        categoryConfidence: '0.9100',
        categoryEvidence: { reason: 'ai' },
      },
      {
        relabelId: 'relabel-t2',
        transactionId: 't2',
        categoryId: 'uncat',
        categorySource: 'uncategorized',
        categoryConfidence: null,
        categoryEvidence: {},
      },
    ]);
  });

  it('skips rows a human (or a later rule) changed since', () => {
    const relabels = [
      relabel('t1', { categoryId: 'misc', source: 'ai_suggested', confidence: null, evidence: {} }),
      relabel('t2', { categoryId: 'misc', source: 'ai_suggested', confidence: null, evidence: {} }),
      relabel('t3', { categoryId: 'misc', source: 'ai_suggested', confidence: null, evidence: {} }),
    ];
    const current = new Map([
      ['t1', { id: 't1', categoryId: 'travel', categorySource: 'manual', categoryEvidence: {} }],
      ['t2', { id: 't2', ...ruleState, categoryEvidence: { learningEventId: 'event-2' } }],
      ['t3', { id: 't3', ...ruleState }],
    ]);
    const plan = planLearnedRuleUndo(eventId, relabels, current);
    expect(plan.skippedTransactionIds).toEqual(['t1', 't2']);
    expect(plan.restore.map((row) => row.transactionId)).toEqual(['t3']);
  });

  it('ignores already-restored and deleted rows', () => {
    const restored = { ...relabel('t1', { categoryId: 'misc', source: 'ai_suggested', confidence: null, evidence: {} }), restoredAt: new Date() };
    const gone = relabel('t2', { categoryId: 'misc', source: 'ai_suggested', confidence: null, evidence: {} });
    const plan = planLearnedRuleUndo(eventId, [restored, gone], new Map([['t1', { id: 't1', ...ruleState }]]));
    expect(plan).toEqual({ restore: [], skippedTransactionIds: [] });
  });
});

describe('planRuleUndo', () => {
  it('deletes a rule the event created, restores one it changed, leaves one re-pointed since', () => {
    expect(planRuleUndo({ categoryId: 'meals', previousRule: null }, { categoryId: 'meals' })).toBe('delete');
    expect(planRuleUndo(
      { categoryId: 'meals', previousRule: { categoryId: 'misc', priority: 100, userConfirmed: false, createdByAi: true } },
      { categoryId: 'meals' },
    )).toBe('restore');
    expect(planRuleUndo({ categoryId: 'meals', previousRule: null }, { categoryId: 'travel' })).toBe('leave');
    expect(planRuleUndo({ categoryId: 'meals', previousRule: null }, null)).toBe('leave');
  });
});
