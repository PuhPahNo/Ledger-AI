import { describe, expect, it } from 'vitest';
import { planAlertSync, spendSpikeCandidate, type AlertCandidate } from './insights.js';

function candidate(dedupeKey: string): AlertCandidate {
  return {
    dedupeKey,
    businessId: null,
    kind: 'dup',
    severity: 'warn',
    title: `Alert ${dedupeKey}`,
    detail: 'detail',
    payload: {},
  };
}

describe('planAlertSync', () => {
  it('inserts new findings and refreshes open ones in place', () => {
    const plan = planAlertSync(
      [candidate('dup:notion'), candidate('dup:slack')],
      [{ id: 'a1', status: 'open', dedupeKey: 'dup:notion' }],
    );
    expect(plan.updates.map((update) => update.id)).toEqual(['a1']);
    expect(plan.inserts.map((insert) => insert.dedupeKey)).toEqual(['dup:slack']);
    expect(plan.deleteIds).toEqual([]);
  });

  it('never resurrects a dismissed alert', () => {
    const plan = planAlertSync(
      [candidate('dup:notion')],
      [{ id: 'a1', status: 'dismissed', dedupeKey: 'dup:notion' }],
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('prefers the dismissal when a key has both an open and a dismissed row', () => {
    const plan = planAlertSync(
      [candidate('dup:notion')],
      [
        { id: 'open', status: 'open', dedupeKey: 'dup:notion' },
        { id: 'gone', status: 'dismissed', dedupeKey: 'dup:notion' },
      ],
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.deleteIds).toEqual(['open']);
  });

  it('clears open alerts that no longer apply and legacy rows without a key', () => {
    const plan = planAlertSync([], [
      { id: 'stale', status: 'open', dedupeKey: 'dup:old' },
      { id: 'legacy', status: 'open', dedupeKey: null },
      { id: 'kept', status: 'dismissed', dedupeKey: 'dup:old2' },
    ]);
    expect(plan.deleteIds.sort()).toEqual(['legacy', 'stale']);
  });

  it('dedupes repeated candidates within one run', () => {
    const plan = planAlertSync([candidate('dup:a'), candidate('dup:a')], []);
    expect(plan.inserts).toHaveLength(1);
  });
});

describe('spendSpikeCandidate', () => {
  it('names the category and uses a month-scoped stable key', () => {
    const alert = spendSpikeCandidate({
      businessId: 'biz-1',
      businessName: 'Womens Net',
      categoryId: 'cat-9',
      categoryName: 'Equipment',
      month: '2026-09',
      currentCents: 210_400,
      previousCents: 94_700,
    });
    expect(alert.title).toBe('Equipment spend up 122% this month');
    expect(alert.detail).toContain('Womens Net');
    expect(alert.dedupeKey).toBe('spike:biz-1:cat-9:2026-09');
  });
});
