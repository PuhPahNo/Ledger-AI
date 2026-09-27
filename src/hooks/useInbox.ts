import { useEffect, useState } from 'react';
import {
  getTransactionRollup,
  listAlerts,
  listCategorizationReviewItems,
  listConnections,
  listReceipts,
  type AlertItem,
} from '@/api';
import type { CategorizationReviewItem, Connection, ReceiptInboxItem } from '@/types/domain';

/**
 * Everything the Inbox lists, loaded once and shared: the Inbox page renders it and the
 * shell's bell / nav badge count it, so the two can never disagree.
 */
export interface InboxData {
  receipts: ReceiptInboxItem[];
  reviewItems: CategorizationReviewItem[];
  troubledConnections: Connection[];
  missingReceipts: { rows: number; outflowCents: number };
  alerts: AlertItem[];
}

export const emptyInbox: InboxData = {
  receipts: [],
  reviewItems: [],
  troubledConnections: [],
  missingReceipts: { rows: 0, outflowCents: 0 },
  alerts: [],
};

export function isTroubledConnection(connection: Connection): boolean {
  return connection.status !== 'live'
    || (connection.health?.failedJobCount ?? 0) > 0
    || Boolean(connection.health?.lastJobError);
}

/**
 * Number of things waiting in the Inbox — the same items, counted the same way, as the page
 * shows. Missing receipts are one summary line on the page, so they count once; counting every
 * transaction would pin the badge at "9+" for as long as any receipt is outstanding.
 */
export function inboxAttentionCount(data: InboxData): number {
  return data.receipts.length
    + data.reviewItems.length
    + data.troubledConnections.length
    + (data.missingReceipts.rows > 0 ? 1 : 0)
    + data.alerts.length;
}

const STALE_MS = 60_000;
let cache: { data: InboxData; loadedAt: number } | null = null;
let inflight: Promise<InboxData> | null = null;
const listeners = new Set<(data: InboxData) => void>();

async function fetchInbox(): Promise<InboxData> {
  const [receipts, reviewItems, connections, rollup, alerts] = await Promise.allSettled([
    listReceipts({ status: 'pending', unmatched: true, limit: 100 }),
    listCategorizationReviewItems(),
    listConnections(),
    // Same definition as the close queue: operating outflow still needing a receipt.
    getTransactionRollup({ receipts: ['missing'], direction: 'operating-outflow' }),
    listAlerts(),
  ]);
  const previous = cache?.data ?? emptyInbox;
  return {
    receipts: receipts.status === 'fulfilled' ? receipts.value : previous.receipts,
    reviewItems: reviewItems.status === 'fulfilled' ? reviewItems.value : previous.reviewItems,
    troubledConnections: connections.status === 'fulfilled'
      ? connections.value.filter(isTroubledConnection)
      : previous.troubledConnections,
    missingReceipts: rollup.status === 'fulfilled'
      ? { rows: rollup.value.rows, outflowCents: rollup.value.operatingOutflowCents }
      : previous.missingReceipts,
    alerts: alerts.status === 'fulfilled' ? alerts.value : previous.alerts,
  };
}

/** Load (or reuse) inbox data. `force` bypasses the short cache, e.g. after resolving an item. */
export function loadInbox(force = false): Promise<InboxData> {
  if (!force && cache && Date.now() - cache.loadedAt < STALE_MS) return Promise.resolve(cache.data);
  if (inflight && !force) return inflight;
  const request = fetchInbox().then((data) => {
    cache = { data, loadedAt: Date.now() };
    listeners.forEach((listener) => listener(data));
    return data;
  }).finally(() => {
    if (inflight === request) inflight = null;
  });
  inflight = request;
  return request;
}

export function clearInboxCache(): void {
  cache = null;
}

export function useInbox(): { data: InboxData; loading: boolean; refresh: () => Promise<InboxData> } {
  const [data, setData] = useState<InboxData>(() => cache?.data ?? emptyInbox);
  const [loading, setLoading] = useState(!cache);
  useEffect(() => {
    let mounted = true;
    const listener = (next: InboxData) => {
      if (mounted) setData(next);
    };
    listeners.add(listener);
    loadInbox()
      .then((next) => {
        if (!mounted) return;
        setData(next);
        setLoading(false);
      })
      .catch(() => mounted && setLoading(false));
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);
  return { data, loading, refresh: () => loadInbox(true) };
}
