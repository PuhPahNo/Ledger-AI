import type { AssistantTokenEnvelope } from './assistantSecurity.js';

/**
 * Durable single-use ledger for assistant approval tokens. A token's jti is inserted exactly
 * once; a second insert (double-click, replay, second tab) finds the row and is rejected.
 * Backed by `assistant_consumed_tokens` (migration 0025).
 */
export interface AssistantTokenStore {
  /** Returns true if this call consumed the jti, false if it was already consumed. */
  consume(envelope: AssistantTokenEnvelope): Promise<boolean>;
  /** Undo a consumption when the guarded action failed, so the user can retry. */
  release(jti: string): Promise<void>;
}

const postgresStore: AssistantTokenStore = {
  async consume(envelope) {
    const { getPool } = await import('../db/client.js');
    const result = await getPool().query(
      `INSERT INTO assistant_consumed_tokens (jti, user_id, kind, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (jti) DO NOTHING
       RETURNING jti`,
      [envelope.jti, envelope.userId, envelope.payload.kind, envelope.expiresAt],
    );
    // Opportunistic cleanup: rows are only useful until the token itself would have expired.
    void getPool()
      .query(`DELETE FROM assistant_consumed_tokens WHERE expires_at < now() - interval '1 day'`)
      .catch(() => undefined);
    return (result.rowCount ?? 0) > 0;
  },
  async release(jti) {
    const { getPool } = await import('../db/client.js');
    await getPool().query('DELETE FROM assistant_consumed_tokens WHERE jti = $1', [jti]);
  },
};

let activeStore: AssistantTokenStore = postgresStore;

export function assistantTokenStore(): AssistantTokenStore {
  return activeStore;
}

/** Test/eval hook: swap the backing store. Returns the previous one. */
export function setAssistantTokenStore(store: AssistantTokenStore): AssistantTokenStore {
  const previous = activeStore;
  activeStore = store;
  return previous;
}

export function createMemoryTokenStore(): AssistantTokenStore {
  const consumed = new Set<string>();
  return {
    async consume(envelope) {
      if (consumed.has(envelope.jti)) return false;
      consumed.add(envelope.jti);
      return true;
    },
    async release(jti) {
      consumed.delete(jti);
    },
  };
}
