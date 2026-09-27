import { describe, expect, it } from 'vitest';
import type { MatchQueueItem, MatchQueuePage } from '@/types/receiptWorkflow';
import {
  currentItem,
  initialQueueState,
  isEditableTarget,
  loadedReceiptIds,
  needsMore,
  queueKeyCommand,
  queueReducer,
  remainingCount,
  type QueueState,
} from './queueState';

function item(id: string, candidates = 2): MatchQueueItem {
  return {
    receipt: {
      id,
      biz: 'draft-sharks',
      source: 'gmail',
      status: 'pending',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
    candidates: Array.from({ length: candidates }, (_, i) => ({
      transaction: { id: `${id}-t${i}` } as MatchQueueItem['candidates'][number]['transaction'],
      score: 0.9,
      reasons: {},
      explanations: [],
      exactAmount: true,
      ambiguous: false,
      suggested: i === 0,
      wouldAutoAttach: false,
      rejected: false,
    })),
    blockedReason: null,
  };
}

function page(ids: string[], total = ids.length, more = false): MatchQueuePage {
  return { items: ids.map((id) => item(id)), total, nextOffset: more ? ids.length : null };
}

function loaded(ids: string[], total?: number, more = false): QueueState {
  return queueReducer(initialQueueState, { type: 'loaded', page: page(ids, total, more) });
}

describe('queueReducer', () => {
  it('loads a page and points at the first receipt', () => {
    const state = loaded(['a', 'b', 'c'], 12, true);
    expect(state.status).toBe('ready');
    expect(currentItem(state)?.receipt.id).toBe('a');
    expect(remainingCount(state)).toBe(12);
    expect(state.exhausted).toBe(false);
  });

  it('acting removes the current item optimistically and counts it as pending', () => {
    const state = queueReducer(loaded(['a', 'b', 'c'], 12), { type: 'act', action: { id: 'x1', kind: 'pair', transactionId: 'a-t0' } });
    expect(currentItem(state)?.receipt.id).toBe('b');
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({ kind: 'pair', position: 0, transactionId: 'a-t0' });
    expect(remainingCount(state)).toBe(11);
  });

  it('undo puts the receipt back where it was and makes it current', () => {
    let state = loaded(['a', 'b', 'c']);
    state = queueReducer(state, { type: 'go', delta: 1 });
    state = queueReducer(state, { type: 'act', action: { id: 'x1', kind: 'dismiss' } });
    expect(currentItem(state)?.receipt.id).toBe('c');
    state = queueReducer(state, { type: 'undo', actionId: 'x1' });
    expect(state.items.map((row) => row.receipt.id)).toEqual(['a', 'b', 'c']);
    expect(currentItem(state)?.receipt.id).toBe('b');
    expect(state.pending).toHaveLength(0);
    expect(remainingCount(state)).toBe(3);
  });

  it('a failed commit rolls back like undo', () => {
    let state = queueReducer(loaded(['a', 'b']), { type: 'act', action: { id: 'x1', kind: 'pair', transactionId: 't' } });
    state = queueReducer(state, { type: 'rollback', actionId: 'x1' });
    expect(currentItem(state)?.receipt.id).toBe('a');
  });

  it('settling keeps the remaining count steady until fresh counts arrive', () => {
    let state = queueReducer(loaded(['a', 'b', 'c'], 5), { type: 'act', action: { id: 'x1', kind: 'pair', transactionId: 't' } });
    expect(remainingCount(state)).toBe(4);
    state = queueReducer(state, { type: 'settled', actionId: 'x1' });
    expect(remainingCount(state)).toBe(4);
    state = queueReducer(state, { type: 'counts', unmatched: 4 });
    expect(remainingCount(state)).toBe(4);
    // Undo after settling is a no-op (nothing pending to put back).
    expect(queueReducer(state, { type: 'undo', actionId: 'x1' })).toBe(state);
  });

  it('skip sends the current receipt to the back and remembers it', () => {
    let state = queueReducer(loaded(['a', 'b', 'c']), { type: 'skip' });
    expect(state.items.map((row) => row.receipt.id)).toEqual(['b', 'c', 'a']);
    expect(currentItem(state)?.receipt.id).toBe('b');
    expect(state.skipped).toEqual(['a']);
    // Skipping the last position wraps to the front.
    state = queueReducer(queueReducer(state, { type: 'go', delta: 5 }), { type: 'skip' });
    expect(currentItem(state)?.receipt.id).toBe('b');
    expect(remainingCount(state)).toBe(3);
  });

  it('skip is a no-op with a single receipt', () => {
    const state = loaded(['a']);
    expect(queueReducer(state, { type: 'skip' })).toBe(state);
  });

  it('prev/next clamp to the list', () => {
    let state = loaded(['a', 'b']);
    state = queueReducer(state, { type: 'go', delta: -1 });
    expect(state.index).toBe(0);
    state = queueReducer(state, { type: 'go', delta: 1 });
    state = queueReducer(state, { type: 'go', delta: 1 });
    expect(state.index).toBe(1);
  });

  it('acting on the last receipt leaves the queue empty', () => {
    const state = queueReducer(loaded(['a']), { type: 'act', action: { id: 'x', kind: 'dismiss' } });
    expect(currentItem(state)).toBeNull();
    expect(remainingCount(state)).toBe(0);
  });

  it('appending skips receipts already loaded or pending, and reloads hide pending ones', () => {
    let state = queueReducer(loaded(['a', 'b'], 4, true), { type: 'act', action: { id: 'x', kind: 'pair', transactionId: 't' } });
    state = queueReducer(state, { type: 'appended', page: page(['a', 'b', 'c'], 4, true) });
    expect(state.items.map((row) => row.receipt.id)).toEqual(['b', 'c']);
    expect(loadedReceiptIds(state).sort()).toEqual(['a', 'b', 'c']);
    state = queueReducer(state, { type: 'loaded', page: page(['a', 'b', 'c', 'd']) });
    expect(state.items.map((row) => row.receipt.id)).toEqual(['b', 'c', 'd']);
  });

  it('asks for more when three or fewer receipts are left locally', () => {
    expect(needsMore(loaded(['a', 'b', 'c', 'd', 'e'], 20, true))).toBe(false);
    expect(needsMore(loaded(['a', 'b', 'c'], 20, true))).toBe(true);
    expect(needsMore(loaded(['a', 'b', 'c'], 3, false))).toBe(false);
  });

  it('replace swaps in edited details; remove drops an auto-matched receipt', () => {
    let state = loaded(['a', 'b']);
    const edited = { ...item('a', 0), blockedReason: 'missing_details' as const };
    state = queueReducer(state, { type: 'replace', item: edited });
    expect(currentItem(state)?.blockedReason).toBe('missing_details');
    state = queueReducer(state, { type: 'remove', receiptId: 'a' });
    expect(currentItem(state)?.receipt.id).toBe('b');
    expect(remainingCount(state)).toBe(1);
  });
});

describe('queueKeyCommand', () => {
  const base = { inEditable: false, candidateCount: 3, hasItem: true, canUndo: true };

  it('maps 1/2/3 to pairing only when that candidate exists', () => {
    expect(queueKeyCommand({ ...base, key: '1' })).toEqual({ type: 'pair', slot: 0 });
    expect(queueKeyCommand({ ...base, key: '3' })).toEqual({ type: 'pair', slot: 2 });
    expect(queueKeyCommand({ ...base, key: '3', candidateCount: 2 })).toBeNull();
    expect(queueKeyCommand({ ...base, key: '1', blocked: true })).toBeNull();
    expect(queueKeyCommand({ ...base, key: '4' })).toBeNull();
  });

  it('maps letters case-insensitively and arrows to navigation', () => {
    expect(queueKeyCommand({ ...base, key: 'n' })).toEqual({ type: 'dismiss' });
    expect(queueKeyCommand({ ...base, key: 'S' })).toEqual({ type: 'skip' });
    expect(queueKeyCommand({ ...base, key: 'e' })).toEqual({ type: 'edit' });
    expect(queueKeyCommand({ ...base, key: 'ArrowLeft' })).toEqual({ type: 'prev' });
    expect(queueKeyCommand({ ...base, key: 'ArrowRight' })).toEqual({ type: 'next' });
    expect(queueKeyCommand({ ...base, key: 'u' })).toEqual({ type: 'undo' });
    expect(queueKeyCommand({ ...base, key: 'u', canUndo: false })).toBeNull();
  });

  it('ignores keys while typing, with modifiers, or under an overlay', () => {
    expect(queueKeyCommand({ ...base, key: 'n', inEditable: true })).toBeNull();
    expect(queueKeyCommand({ ...base, key: '1', metaKey: true })).toBeNull();
    expect(queueKeyCommand({ ...base, key: 's', ctrlKey: true })).toBeNull();
    expect(queueKeyCommand({ ...base, key: 'e', overlayOpen: true })).toBeNull();
  });

  it('only undo works on an empty queue', () => {
    expect(queueKeyCommand({ ...base, key: 'n', hasItem: false })).toBeNull();
    expect(queueKeyCommand({ ...base, key: 'u', hasItem: false })).toEqual({ type: 'undo' });
  });
});

describe('isEditableTarget', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({
    tagName,
    isContentEditable: false,
    getAttribute: () => null,
    ...extra,
  }) as unknown as EventTarget;

  it('treats text inputs, textareas and selects as editable but not checkboxes or buttons', () => {
    expect(isEditableTarget(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isEditableTarget(el('TEXTAREA'))).toBe(true);
    expect(isEditableTarget(el('SELECT'))).toBe(true);
    expect(isEditableTarget(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isEditableTarget(el('BUTTON'))).toBe(false);
    expect(isEditableTarget(el('DIV', { isContentEditable: true }))).toBe(true);
    expect(isEditableTarget(null)).toBe(false);
  });
});
