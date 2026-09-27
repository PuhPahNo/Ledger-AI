import { describe, expect, it, vi } from 'vitest';
import { NonRetryableJobError } from '../jobs/queue.js';
import {
  PLAID_TRANSACTION_HISTORY_DAYS,
  PlaidSyncBlockedError,
  collectPlaidSyncPages,
  plaidAmountCents,
  plaidBalanceCents,
  plaidSyncBlockedMessage,
  runPlaidSync,
  type PlaidSyncPage,
  type PlaidSyncSteps,
  type UnassignableAccountSummary,
} from './plaid.js';

describe('PLAID_TRANSACTION_HISTORY_DAYS', () => {
  it('requests one year of transaction history for new links and explicit backfills', () => {
    expect(PLAID_TRANSACTION_HISTORY_DAYS).toBe(365);
  });
});

describe('plaidBalanceCents', () => {
  it('converts Plaid dollar balances to cents', () => {
    expect(plaidBalanceCents(1234.56)).toBe(123456);
    expect(plaidBalanceCents('12.34')).toBe(1234);
  });

  it('returns null for missing or invalid balances', () => {
    expect(plaidBalanceCents(null)).toBeNull();
    expect(plaidBalanceCents(undefined)).toBeNull();
    expect(plaidBalanceCents('not-a-number')).toBeNull();
  });
});

describe('plaidAmountCents', () => {
  it('keeps normal Plaid charges as app outflows', () => {
    expect(plaidAmountCents({ amount: 123.45 })).toBe(-12345);
  });

  it('uses Plaid income hints to force app inflows', () => {
    expect(plaidAmountCents({
      amount: 123.45,
      personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_OTHER_INCOME' },
    })).toBe(12345);
  });

  it('uses Plaid transfer-in hints to keep incoming transfers out of spend', () => {
    expect(plaidAmountCents({
      amount: 2000,
      personal_finance_category: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_DEPOSIT' },
    })).toBe(200000);
  });
});

describe('collectPlaidSyncPages', () => {
  const page = (overrides: Partial<PlaidSyncPage>): PlaidSyncPage => ({
    accounts: [], added: [], modified: [], removed: [], next_cursor: 'c', has_more: false, ...overrides,
  });

  it('restarts from the original cursor on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION and drops partial pages', async () => {
    const calls: Array<string | undefined> = [];
    let failed = false;
    const fetchPage = vi.fn(async (cursor: string | undefined) => {
      calls.push(cursor);
      if (cursor === 'start') return page({ added: [{ transaction_id: 'stale' }], next_cursor: 'p2', has_more: true });
      if (cursor === 'p2' && !failed) {
        failed = true;
        throw Object.assign(new Error('mutation'), { response: { data: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } } });
      }
      return page({ added: [{ transaction_id: 'b' }], next_cursor: 'end' });
    });
    const batch = await collectPlaidSyncPages(fetchPage, 'start');
    expect(calls).toEqual(['start', 'p2', 'start', 'p2']);
    expect(batch.added.map((txn) => txn.transaction_id)).toEqual(['stale', 'b']);
    expect(batch.nextCursor).toBe('end');
  });

  it('gives up after the restart limit and rethrows other errors immediately', async () => {
    const mutation = Object.assign(new Error('mutation'), { response: { data: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } } });
    const alwaysMutating = vi.fn(async () => { throw mutation; });
    await expect(collectPlaidSyncPages(alwaysMutating, 'start', 2)).rejects.toBe(mutation);
    expect(alwaysMutating).toHaveBeenCalledTimes(3);

    const other = new Error('boom');
    const failing = vi.fn(async () => { throw other; });
    await expect(collectPlaidSyncPages(failing, 'start')).rejects.toBe(other);
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

describe('runPlaidSync', () => {
  function makeSteps(pages: PlaidSyncPage[], unassignable: UnassignableAccountSummary[] = []) {
    const log: string[] = [];
    const queue = [...pages];
    const steps: PlaidSyncSteps = {
      fetchPage: vi.fn(async () => queue.shift()!),
      upsertAccounts: vi.fn(async (accounts) => { log.push(`accounts:${accounts.map((a) => a.account_id).join(',')}`); }),
      findUnassignable: vi.fn(async () => unassignable),
      markBlocked: vi.fn(async () => { log.push('blocked'); }),
      applyAdded: vi.fn(async (txn) => { log.push(`added:${txn.transaction_id}`); return true; }),
      applyModified: vi.fn(async (txn) => { log.push(`modified:${txn.transaction_id}`); }),
      applyRemoved: vi.fn(async (id) => { log.push(`removed:${id}`); return true; }),
      commit: vi.fn(async (cursor, added) => { log.push(`commit:${cursor}:${added}`); }),
    };
    return { steps, log };
  }

  it('fetches every page, then applies added, modified, removed, and only then saves the cursor', async () => {
    const { steps, log } = makeSteps([
      // The pending row's removal arrives on an earlier page than its posted replacement.
      { accounts: [{ account_id: 'acct' }], added: [], modified: [], removed: [{ transaction_id: 'pending-1' }], next_cursor: 'c1', has_more: true },
      { accounts: [{ account_id: 'acct' }], added: [{ transaction_id: 'posted-1', pending_transaction_id: 'pending-1' }], modified: [{ transaction_id: 'm1' }], removed: [], next_cursor: 'c2', has_more: false },
    ]);
    const result = await runPlaidSync('c0', steps);
    expect(log).toEqual([
      'accounts:acct',
      'added:posted-1',
      'modified:m1',
      'removed:pending-1',
      'commit:c2:1',
    ]);
    expect(result).toEqual({ added: 1, changed: 2 });
  });

  it('does not advance the cursor or write transactions when some cannot be assigned a business', async () => {
    const unassignable = [{ plaidAccountId: 'acct', label: 'Checking ••1234', count: 2 }];
    const { steps, log } = makeSteps([
      { accounts: [{ account_id: 'acct' }], added: [{ transaction_id: 'a' }, { transaction_id: 'b' }], modified: [], removed: [{ transaction_id: 'r' }], next_cursor: 'c1', has_more: false },
    ], unassignable);
    const error = await runPlaidSync('c0', steps).catch((caught) => caught);
    expect(error).toBeInstanceOf(PlaidSyncBlockedError);
    expect(error).toBeInstanceOf(NonRetryableJobError);
    expect(error.message).toContain('Checking ••1234');
    expect(error.message).toContain('2 transactions');
    // Accounts are still upserted so the owner can assign them a business.
    expect(log).toEqual(['accounts:acct', 'blocked']);
    expect(steps.commit).not.toHaveBeenCalled();
  });

  it('does not save the cursor when applying a transaction fails', async () => {
    const { steps } = makeSteps([
      { accounts: [], added: [{ transaction_id: 'a' }], modified: [], removed: [], next_cursor: 'c1', has_more: false },
    ]);
    steps.applyAdded = vi.fn(async () => { throw new Error('db down'); });
    await expect(runPlaidSync('c0', steps)).rejects.toThrow('db down');
    expect(steps.commit).not.toHaveBeenCalled();
  });
});

describe('plaidSyncBlockedMessage', () => {
  it('names every blocked account and says nothing was skipped', () => {
    const message = plaidSyncBlockedMessage([
      { plaidAccountId: 'a', label: 'Checking ••1', count: 1 },
      { plaidAccountId: 'b', label: 'Card ••2', count: 3 },
    ]);
    expect(message).toContain('4 transactions on Checking ••1, Card ••2');
    expect(message).toContain('nothing was skipped');
  });
});
