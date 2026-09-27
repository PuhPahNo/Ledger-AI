import { useCallback, useEffect, useState } from 'react';
import { getQuickbooksStatus } from '@/api/quickbooks';
import type { QboStatus } from '@/types/quickbooks';

// Shared, short-lived cache: the drawer panel asks for status on every transaction it opens.
const STALE_MS = 60_000;
let cache: { status: QboStatus; loadedAt: number } | null = null;
let inflight: Promise<QboStatus> | null = null;

export function loadQuickbooksStatus(force = false): Promise<QboStatus> {
  if (!force && cache && Date.now() - cache.loadedAt < STALE_MS) return Promise.resolve(cache.status);
  if (inflight && !force) return inflight;
  const request = getQuickbooksStatus()
    .then((status) => {
      cache = { status, loadedAt: Date.now() };
      return status;
    })
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

/** True when at least one business (or the given business key) has a QuickBooks connection. */
export function hasQuickbooksConnection(status: QboStatus | null, businessKey?: string): boolean {
  if (!status?.configured) return false;
  return status.businesses.some((business) => business.connection && (!businessKey || business.businessKey === businessKey));
}

export function useQuickbooksStatus(): { status: QboStatus | null; error: string; reload: () => Promise<void> } {
  const [status, setStatus] = useState<QboStatus | null>(() => cache?.status ?? null);
  const [error, setError] = useState('');
  const load = useCallback(async (force: boolean) => {
    try {
      setStatus(await loadQuickbooksStatus(force));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load QuickBooks status');
    }
  }, []);
  useEffect(() => {
    void load(false);
  }, [load]);
  return { status, error, reload: () => load(true) };
}
