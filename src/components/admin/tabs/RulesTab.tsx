import { useEffect, useState } from 'react';
import { History, ListChecks, Trash2 } from 'lucide-react';
import {
  applyCategoryRule,
  createCategoryRule,
  deleteCategoryRule,
  listCategoryRules,
  patchCategoryRule,
  type AdminOverview,
  type CategoryRuleRow,
} from '@/api';
import type { Business } from '@/types/domain';
import { useToast } from '@/hooks/useToast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FieldBusiness, FieldSelect, FieldText, type SaveAndRefresh } from '../fields';

interface Props {
  data: AdminOverview;
  businesses: Business[];
  saveAndRefresh: SaveAndRefresh;
}

const MATCH_KINDS = [
  { value: 'merchant_contains', label: 'Merchant contains' },
  { value: 'merchant_exact', label: 'Merchant exact' },
  { value: 'plaid_category', label: 'Plaid category' },
  { value: 'amount_range', label: 'Amount range' },
];

const MATCH_KIND_LABELS: Record<CategoryRuleRow['matchKind'], string> = {
  merchant_exact: 'Merchant is',
  merchant_contains: 'Merchant contains',
  plaid_category: 'Bank category',
  amount_range: 'Amount range',
};

/**
 * Every categorization rule the system has learned or been given, plus a form to add
 * new ones by hand. New transactions check these first — before bank signals or AI.
 */
export function RulesTab({ data, businesses, saveAndRefresh }: Props) {
  const { toast } = useToast();
  const [rules, setRules] = useState<CategoryRuleRow[]>([]);
  const [business, setBusiness] = useState('all');
  const [loading, setLoading] = useState(true);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [ruleForm, setRuleForm] = useState({
    categoryId: '',
    businessId: '',
    matchKind: 'merchant_contains',
    pattern: '',
    priority: 100,
  });

  useEffect(() => {
    setLoading(true);
    setError('');
    listCategoryRules(business)
      .then(setRules)
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [business, refreshKey]);

  const refresh = () => setRefreshKey((key) => key + 1);

  const handleCreate = async () => {
    const created = await saveAndRefresh(
      () => createCategoryRule({ ...ruleForm, businessId: ruleForm.businessId || null }),
      'Rule created.',
    );
    if (created) {
      setRuleForm({ ...ruleForm, pattern: '' });
      refresh();
    }
  };

  const handleCategoryChange = async (rule: CategoryRuleRow, categoryId: string) => {
    setBusyRuleId(rule.id);
    try {
      await patchCategoryRule(rule.id, { categoryId });
      toast({ variant: 'success', title: 'Rule updated' });
      refresh();
    } catch (updateError) {
      toast({
        variant: 'destructive',
        title: 'Could not update rule',
        description: updateError instanceof Error ? updateError.message : 'Try again.',
      });
    } finally {
      setBusyRuleId(null);
    }
  };

  const handleApply = async (rule: CategoryRuleRow) => {
    setBusyRuleId(rule.id);
    try {
      const result = await applyCategoryRule(rule.id);
      toast({
        variant: 'success',
        title: `Re-categorized ${result.appliedCount} transaction${result.appliedCount === 1 ? '' : 's'}`,
        description: result.skippedProtected > 0
          ? `${result.skippedProtected} kept their manually-set category.`
          : undefined,
      });
      refresh();
    } catch (applyError) {
      toast({
        variant: 'destructive',
        title: 'Could not apply rule',
        description: applyError instanceof Error ? applyError.message : 'Try again.',
      });
    } finally {
      setBusyRuleId(null);
    }
  };

  const handleDelete = async (rule: CategoryRuleRow) => {
    setBusyRuleId(rule.id);
    try {
      await deleteCategoryRule(rule.id);
      toast({ variant: 'success', title: 'Rule deleted', description: `"${rule.pattern}" no longer applies.` });
      refresh();
    } catch (deleteError) {
      toast({
        variant: 'destructive',
        title: 'Could not delete rule',
        description: deleteError instanceof Error ? deleteError.message : 'Try again.',
      });
    } finally {
      setBusyRuleId(null);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="lg:col-span-4 self-start">
        <CardHeader>
          <CardTitle>Create rule</CardTitle>
          <CardDescription>Automatically categorize transactions that match a pattern.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <FieldBusiness
            label="Scope"
            value={ruleForm.businessId}
            businesses={businesses}
            onChange={(businessId) => setRuleForm({ ...ruleForm, businessId })}
          />
          <FieldSelect
            label="Category"
            value={ruleForm.categoryId}
            onChange={(categoryId) => setRuleForm({ ...ruleForm, categoryId })}
            placeholder="Choose"
            options={data.categories.map((category) => ({ value: category.id, label: category.name }))}
          />
          <FieldSelect
            label="Match"
            value={ruleForm.matchKind}
            onChange={(matchKind) => setRuleForm({ ...ruleForm, matchKind })}
            options={MATCH_KINDS}
          />
          <FieldText label="Pattern" value={ruleForm.pattern} onChange={(pattern) => setRuleForm({ ...ruleForm, pattern })} />
          <FieldText
            label="Priority"
            type="number"
            value={String(ruleForm.priority)}
            onChange={(priority) => setRuleForm({ ...ruleForm, priority: Number(priority) })}
          />
          <Button onClick={handleCreate}>Create rule</Button>
        </CardContent>
      </Card>

      <Card className="lg:col-span-8">
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="grid gap-1.5">
            <CardTitle>Rules</CardTitle>
            <CardDescription>
              Learned from your corrections plus any added by hand. "Apply to history" re-categorizes
              machine-guessed transactions; anything you set manually is left alone.
            </CardDescription>
          </div>
          <Select value={business} onValueChange={setBusiness}>
            <SelectTrigger className="h-8 w-44 shrink-0 text-xs">
              <SelectValue placeholder="Business" />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="all">All businesses</SelectItem>
              {businesses.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.short} · {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="rounded-xl border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral-ink">{error}</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[220px]">Rule</TableHead>
                      <TableHead className="w-52">Category</TableHead>
                      <TableHead className="w-40">Business</TableHead>
                      <TableHead className="w-28 text-right">Matches</TableHead>
                      <TableHead className="w-56 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[11px] uppercase tracking-wide text-dim">
                              {MATCH_KIND_LABELS[rule.matchKind] ?? rule.matchKind}
                            </span>
                            <span className="font-bold">“{rule.pattern}”</span>
                            {rule.createdByAi && <Badge variant="secondary">AI-created</Badge>}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={rule.categoryId}
                            onValueChange={(value) => handleCategoryChange(rule, value)}
                            disabled={busyRuleId === rule.id}
                          >
                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {data.categories.map((category) => (
                                <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>
                              ))}
                              {!data.categories.some((category) => category.id === rule.categoryId) && (
                                <SelectItem value={rule.categoryId}>{rule.categoryName}</SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-xs text-dim">{rule.businessName ?? 'All businesses'}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {rule.matchCount == null ? '—' : rule.matchCount}
                          {rule.mismatchCount != null && rule.mismatchCount > 0 && (
                            <span className="ml-1.5 rounded-full bg-coral/15 px-1.5 py-0.5 text-[10px] font-bold text-coral-ink">
                              {rule.mismatchCount} differ
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyRuleId === rule.id || rule.mismatchCount === 0}
                              onClick={() => handleApply(rule)}
                              title="Re-categorize matching transactions (manual categories are kept)"
                            >
                              <History className="h-3.5 w-3.5" />
                              Apply to history
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyRuleId === rule.id}
                              onClick={() => handleDelete(rule)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {loading && <div className="p-6 text-center text-sm text-dim">Loading rules...</div>}
              {!loading && rules.length === 0 && (
                <div className="p-8">
                  <EmptyState
                    title="No rules yet"
                    description="Correct a transaction's category and accept the learning prompt — the rule will show up here."
                    icon={<ListChecks className="h-5 w-5" />}
                  />
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
