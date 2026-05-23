export interface TransactionOverrideInput {
  businessId?: string;
  categoryId?: string | null;
  note?: string | null;
}

export function normalizeTransactionOverride(input: TransactionOverrideInput): TransactionOverrideInput {
  return {
    ...(input.businessId ? { businessId: input.businessId } : {}),
    ...(input.categoryId !== undefined ? { categoryId: input.categoryId || null } : {}),
    ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
  };
}
