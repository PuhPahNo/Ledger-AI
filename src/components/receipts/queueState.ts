// Pure state for the receipt match queue: the local list, the current position, skipped
// receipts, and actions still inside their undo window. The component commits an action to the
// server only after the undo window closes, so Undo never has to reverse a server write (an
// unpair would record the pair as rejected and hide the right candidate for good).
import type { MatchQueueItem, MatchQueuePage } from '@/types/receiptWorkflow';

export type QueueActionKind = 'pair' | 'dismiss';

export interface PendingQueueAction {
  id: string;
  kind: QueueActionKind;
  item: MatchQueueItem;
  /** For 'pair': the transaction chosen (a candidate or one picked from search). */
  transactionId?: string;
  /** Label for the Undo toast, e.g. the transaction merchant. */
  label?: string;
  /** Where the item sat, so Undo puts it back in place. */
  position: number;
}

export interface QueueState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  items: MatchQueueItem[];
  index: number;
  /** Receipt ids skipped this session — sent to the server so they don't come straight back. */
  skipped: string[];
  pending: PendingQueueAction[];
  /** Unmatched receipts per the server (counts endpoint or queue total). */
  base: number;
  /** Actions committed since `base` was last read from the server. */
  settledSinceBase: number;
  /** The server has nothing beyond what is loaded. */
  exhausted: boolean;
}

export type QueueEvent =
  | { type: 'loading' }
  | { type: 'loaded'; page: MatchQueuePage }
  | { type: 'appended'; page: MatchQueuePage }
  | { type: 'failed'; error: string }
  | { type: 'counts'; unmatched: number }
  | { type: 'act'; action: Omit<PendingQueueAction, 'item' | 'position'> }
  | { type: 'skip' }
  | { type: 'undo'; actionId: string }
  | { type: 'settled'; actionId: string }
  | { type: 'rollback'; actionId: string }
  | { type: 'go'; delta: number }
  | { type: 'replace'; item: MatchQueueItem }
  | { type: 'remove'; receiptId: string };

export const initialQueueState: QueueState = {
  status: 'loading',
  error: null,
  items: [],
  index: 0,
  skipped: [],
  pending: [],
  base: 0,
  settledSinceBase: 0,
  exhausted: false,
};

const clampIndex = (index: number, length: number) => Math.max(0, Math.min(index, Math.max(0, length - 1)));

function reinsert(state: QueueState, action: PendingQueueAction): QueueState {
  const position = Math.min(action.position, state.items.length);
  const items = [...state.items.slice(0, position), action.item, ...state.items.slice(position)];
  return {
    ...state,
    items,
    index: position,
    pending: state.pending.filter((row) => row.id !== action.id),
  };
}

export function queueReducer(state: QueueState, event: QueueEvent): QueueState {
  switch (event.type) {
    case 'loading':
      return { ...state, status: 'loading', error: null };
    case 'loaded': {
      // Anything still in an undo window stays out of the list.
      const hidden = new Set(state.pending.map((row) => row.item.receipt.id));
      const items = event.page.items.filter((item) => !hidden.has(item.receipt.id));
      return {
        ...state,
        status: 'ready',
        error: null,
        items,
        index: 0,
        base: event.page.total + state.skipped.length,
        settledSinceBase: 0,
        exhausted: event.page.nextOffset == null,
      };
    }
    case 'appended': {
      const seen = new Set([
        ...state.items.map((item) => item.receipt.id),
        ...state.pending.map((row) => row.item.receipt.id),
      ]);
      const fresh = event.page.items.filter((item) => !seen.has(item.receipt.id));
      return { ...state, items: [...state.items, ...fresh], exhausted: event.page.nextOffset == null || fresh.length === 0 };
    }
    case 'failed':
      return { ...state, status: 'error', error: event.error };
    case 'counts':
      return { ...state, base: event.unmatched, settledSinceBase: 0 };
    case 'act': {
      const item = state.items[state.index];
      if (!item) return state;
      const items = state.items.filter((_, i) => i !== state.index);
      return {
        ...state,
        items,
        index: clampIndex(state.index, items.length),
        pending: [...state.pending, { ...event.action, item, position: state.index }],
      };
    }
    case 'skip': {
      const item = state.items[state.index];
      if (!item || state.items.length < 2) return state;
      const items = [...state.items.filter((_, i) => i !== state.index), item];
      const skipped = state.skipped.includes(item.receipt.id) ? state.skipped : [...state.skipped, item.receipt.id];
      // The next receipt slides into this slot; skipping the last one wraps to the front.
      return { ...state, items, skipped, index: state.index >= items.length - 1 ? 0 : state.index };
    }
    case 'undo':
    case 'rollback': {
      const action = state.pending.find((row) => row.id === event.actionId);
      return action ? reinsert(state, action) : state;
    }
    case 'settled': {
      if (!state.pending.some((row) => row.id === event.actionId)) return state;
      return {
        ...state,
        pending: state.pending.filter((row) => row.id !== event.actionId),
        settledSinceBase: state.settledSinceBase + 1,
      };
    }
    case 'go':
      return { ...state, index: clampIndex(state.index + event.delta, state.items.length) };
    case 'replace':
      return {
        ...state,
        items: state.items.map((item) => (item.receipt.id === event.item.receipt.id ? event.item : item)),
      };
    case 'remove': {
      const at = state.items.findIndex((item) => item.receipt.id === event.receiptId);
      if (at < 0) return state;
      const items = state.items.filter((_, i) => i !== at);
      return {
        ...state,
        items,
        index: clampIndex(at < state.index ? state.index - 1 : state.index, items.length),
        settledSinceBase: state.settledSinceBase + 1,
      };
    }
    default:
      return state;
  }
}

export function currentItem(state: QueueState): MatchQueueItem | null {
  return state.items[state.index] ?? null;
}

/** Receipts still to handle: the server's count minus what was paired/dismissed since. */
export function remainingCount(state: QueueState): number {
  const floor = state.items.length;
  return Math.max(floor, state.base - state.settledSinceBase - state.pending.length);
}

/** Time to fetch more: the local list is running low and the server may have more. */
export function needsMore(state: QueueState): boolean {
  return state.status === 'ready' && !state.exhausted && state.items.length - state.index <= 3;
}

/** Receipt ids the server should leave out of the next page (already loaded or acted on). */
export function loadedReceiptIds(state: QueueState): string[] {
  return [
    ...state.items.map((item) => item.receipt.id),
    ...state.pending.map((row) => row.item.receipt.id),
    ...state.skipped,
  ].filter((id, index, all) => all.indexOf(id) === index);
}

// ---------------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------------

export type QueueCommand =
  | { type: 'pair'; slot: number }
  | { type: 'dismiss' }
  | { type: 'skip' }
  | { type: 'edit' }
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'undo' };

export interface QueueKeyInput {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** Focus is in a text field, select or contenteditable — typing must not trigger actions. */
  inEditable: boolean;
  /** A dialog/sheet is open over the queue. */
  overlayOpen?: boolean;
  candidateCount: number;
  /** The current receipt can't be paired yet (still reading / missing details). */
  blocked?: boolean;
  hasItem: boolean;
  canUndo?: boolean;
}

/** Map a keypress to a queue command, or null when the key should be left alone. */
export function queueKeyCommand(input: QueueKeyInput): QueueCommand | null {
  if (input.inEditable || input.overlayOpen || input.altKey || input.ctrlKey || input.metaKey) return null;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (key === 'u') return input.canUndo ? { type: 'undo' } : null;
  if (!input.hasItem) return null;
  if (key === '1' || key === '2' || key === '3') {
    const slot = Number(key) - 1;
    return !input.blocked && slot < input.candidateCount ? { type: 'pair', slot } : null;
  }
  switch (key) {
    case 'n':
      return { type: 'dismiss' };
    case 's':
      return { type: 'skip' };
    case 'e':
      return { type: 'edit' };
    case 'ArrowLeft':
      return { type: 'prev' };
    case 'ArrowRight':
      return { type: 'next' };
    default:
      return null;
  }
}

/** True when keyboard focus is somewhere typing belongs. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (element as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
  }
  return element.isContentEditable || element.getAttribute('role') === 'combobox';
}
