import { http, useMockApi } from './client';

export interface CategoryRuleRow {
  id: string;
  businessId: string | null;
  biz: string | null;
  businessName: string | null;
  categoryId: string;
  categoryName: string;
  matchKind: 'merchant_exact' | 'merchant_contains' | 'plaid_category' | 'amount_range';
  pattern: string;
  priority: number;
  createdByAi: boolean;
  createdAt: string;
  updatedAt: string;
  /** Spend transactions this rule currently matches; null when uncountable (plaid_category). */
  matchCount: number | null;
  /** Matches whose current category differs from the rule's target. */
  mismatchCount: number | null;
}

export function listCategoryRules(biz?: string): Promise<CategoryRuleRow[]> {
  if (useMockApi) {
    const now = new Date().toISOString();
    return Promise.resolve([
      {
        id: 'mock-rule-1',
        businessId: null,
        biz: 'draft-sharks',
        businessName: 'Draft Sharks',
        categoryId: 'mock-category-software',
        categoryName: 'Software',
        matchKind: 'merchant_exact',
        pattern: 'figma',
        priority: 1,
        createdByAi: false,
        createdAt: now,
        updatedAt: now,
        matchCount: 12,
        mismatchCount: 0,
      },
    ]);
  }
  const query = biz && biz !== 'all' ? `?biz=${encodeURIComponent(biz)}` : '';
  return http<CategoryRuleRow[]>(`/categorization/rules${query}`);
}

export function patchCategoryRule(
  ruleId: string,
  body: { categoryId?: string; priority?: number },
): Promise<{ ok: true }> {
  if (useMockApi) return Promise.resolve({ ok: true });
  return http<{ ok: true }>(`/categorization/rules/${ruleId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteCategoryRule(ruleId: string): Promise<void> {
  if (useMockApi) return Promise.resolve();
  return http<void>(`/categorization/rules/${ruleId}`, { method: 'DELETE' });
}

export function applyCategoryRule(
  ruleId: string,
  options: { includeProtected?: boolean } = {},
): Promise<{ appliedCount: number; skippedProtected: number }> {
  if (useMockApi) return Promise.resolve({ appliedCount: 0, skippedProtected: 0 });
  return http<{ appliedCount: number; skippedProtected: number }>(`/categorization/rules/${ruleId}/apply`, {
    method: 'POST',
    body: JSON.stringify(options),
  });
}
