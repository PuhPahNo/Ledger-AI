export function resolveTransactionBusinessId(accountBusinessId?: string | null, connectionBusinessId?: string | null): string | undefined {
  return accountBusinessId ?? connectionBusinessId ?? undefined;
}
