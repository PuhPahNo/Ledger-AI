import { useCallback, useEffect, useState } from 'react';
import { Loader2, ReceiptText, RefreshCw, Trash2 } from 'lucide-react';
import {
  applyWaivers,
  deleteWaiverRule,
  listWaiverRules,
  previewApplyWaivers,
  updateThresholdRule,
} from '@/api/receiptWorkflow';
import type { ReceiptWaiverRule, WaiverApplyPreview } from '@/types/receiptWorkflow';
import { useToast } from '@/hooks/useToast';
import { fmt$ } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { formatCentsInput, parseDollarInput } from './ReceiptWorkbenchParts';

const DEFAULT_THRESHOLD_CENTS = 7500;

/**
 * Settings → Receipt rules: the global "no receipt needed under $X" threshold, the merchant and
 * category rules created from transactions, and applying rules to what's already missing.
 */
export function ReceiptRulesSettings() {
  const { toast } = useToast();
  const [rules, setRules] = useState<ReceiptWaiverRule[] | null>(null);
  const [error, setError] = useState('');
  const [loadKey, setLoadKey] = useState(0);

  const load = useCallback(() => setLoadKey((key) => key + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError('');
    listWaiverRules()
      .then((rows) => !cancelled && setRules(rows))
      .catch((loadError: Error) => !cancelled && setError(loadError.message));
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  if (error) {
    return (
      <EmptyState
        title="Couldn't load receipt rules"
        description={error}
        action={<Button variant="outline" onClick={load}><RefreshCw className="h-4 w-4" />Retry</Button>}
      />
    );
  }

  if (!rules) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  const threshold = rules.find((rule) => rule.kind === 'threshold') ?? null;
  const others = rules.filter((rule) => rule.kind !== 'threshold');

  const replaceRule = (rule: ReceiptWaiverRule) => setRules((current) => current?.map((row) => (row.id === rule.id ? rule : row)) ?? current);

  return (
    <div className="grid gap-4">
      <ThresholdCard
        rule={threshold}
        onSaved={(rule) => {
          replaceRule(rule);
          toast({ variant: 'success', title: rule.enabled ? `No receipt needed ${rule.label.toLowerCase()}` : 'Threshold rule off' });
        }}
      />
      <RulesCard rules={others} onDeleted={load} />
      <ApplyCard rules={rules} onApplied={load} />
    </div>
  );
}

function ThresholdCard({ rule, onSaved }: { rule: ReceiptWaiverRule | null; onSaved: (rule: ReceiptWaiverRule) => void }) {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(rule?.enabled ?? false);
  const [amount, setAmount] = useState(formatCentsInput(rule?.thresholdCents ?? DEFAULT_THRESHOLD_CENTS));
  const [excludeLodging, setExcludeLodging] = useState(rule?.excludeLodging ?? true);
  const [saving, setSaving] = useState(false);

  const save = async (next: { enabled?: boolean; excludeLodging?: boolean } = {}) => {
    const cents = parseDollarInput(amount);
    if (!cents || cents < 100) {
      toast({ variant: 'destructive', title: 'Enter an amount of at least $1' });
      return;
    }
    const input = { enabled: next.enabled ?? enabled, thresholdCents: cents, excludeLodging: next.excludeLodging ?? excludeLodging };
    setSaving(true);
    try {
      const saved = await updateThresholdRule(input);
      setEnabled(saved.enabled);
      setExcludeLodging(saved.excludeLodging);
      setAmount(formatCentsInput(saved.thresholdCents));
      onSaved(saved);
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not save rule', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const amountChanged = parseDollarInput(amount) !== (rule?.thresholdCents ?? DEFAULT_THRESHOLD_CENTS);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0">
          <CardTitle>No receipt needed for small purchases</CardTitle>
          <CardDescription>Transactions under the amount won't be flagged as missing a receipt.</CardDescription>
        </div>
        {/* The label widens the small switch into a 40px touch target. */}
        <label htmlFor="receipt-threshold-switch" className="-my-2 flex h-10 w-12 shrink-0 cursor-pointer items-center justify-end">
          <Switch
            id="receipt-threshold-switch"
            checked={enabled}
            disabled={saving}
            aria-label="No receipt needed under the threshold"
            onCheckedChange={(checked) => void save({ enabled: checked })}
          />
        </label>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="receipt-threshold" className="text-sm font-bold">Under</label>
          <div className="relative w-28">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-dim">$</span>
            <Input
              id="receipt-threshold"
              value={amount}
              inputMode="decimal"
              onChange={(event) => setAmount(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void save()}
              className="pl-6 tabular-nums"
            />
          </div>
          {amountChanged && (
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          )}
        </div>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 sm:min-h-0">
          <input
            type="checkbox"
            checked={excludeLodging}
            disabled={saving}
            onChange={(event) => void save({ excludeLodging: event.target.checked })}
            className="h-4 w-4 accent-ink"
          />
          <span className="text-sm">Still require receipts for travel &amp; lodging</span>
        </label>
        <p className="text-xs text-dim">
          IRS guidance: receipts generally aren't required for business expenses under $75, except lodging. Guidance, not tax advice.
        </p>
      </CardContent>
    </Card>
  );
}

function RulesCard({ rules, onDeleted }: { rules: ReceiptWaiverRule[]; onDeleted: () => void }) {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState<ReceiptWaiverRule | null>(null);
  const [deleting, setDeleting] = useState(false);

  const remove = async (rule: ReceiptWaiverRule, reopen: boolean) => {
    setDeleting(true);
    try {
      const result = await deleteWaiverRule(rule.id, { reopen });
      toast({
        variant: 'success',
        title: 'Rule deleted',
        description: reopen && result.reopened
          ? `${result.reopened} transaction${result.reopened === 1 ? '' : 's'} need a receipt again.`
          : undefined,
      });
      setConfirming(null);
      onDeleted();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not delete rule', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Merchant &amp; category rules</CardTitle>
        <CardDescription>Created from a transaction with “No receipt needed → Always for this merchant”.</CardDescription>
      </CardHeader>
      <CardContent>
        {rules.length === 0 ? (
          <EmptyState
            icon={<ReceiptText className="h-5 w-5" />}
            title="No rules yet"
            description="Open a transaction missing a receipt and choose No receipt needed → Always for this merchant."
          />
        ) : (
          <ul className="divide-y divide-ink2/10">
            {rules.map((rule) => (
              <li key={rule.id} className="flex min-w-0 items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold" title={rule.label}>{ruleTitle(rule)}</div>
                  <div className="truncate text-xs text-dim">
                    {rule.kind === 'merchant' ? 'Merchant' : 'Category'}
                    {rule.businessId ? ' · one business' : ''}
                    {rule.note ? ` · ${rule.note}` : ''}
                  </div>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-dim">{rule.waivedCount} waived</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete rule ${rule.label}`}
                  title="Delete rule"
                  onClick={() => (rule.waivedCount > 0 ? setConfirming(rule) : void remove(rule, false))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <Dialog open={Boolean(confirming)} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{confirming ? ruleTitle(confirming) : ''}”?</DialogTitle>
            <DialogDescription>
              This rule currently waives {confirming?.waivedCount} transaction{confirming?.waivedCount === 1 ? '' : 's'}.
              Reopen them so they need a receipt again, or keep them waived.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={deleting} onClick={() => confirming && void remove(confirming, false)}>
              Delete, keep waived
            </Button>
            <Button disabled={deleting} onClick={() => confirming && void remove(confirming, true)}>
              Delete &amp; reopen {confirming?.waivedCount}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ApplyCard({ rules, onApplied }: { rules: ReceiptWaiverRule[]; onApplied: () => void }) {
  const { toast } = useToast();
  const [preview, setPreview] = useState<WaiverApplyPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const anyEnabled = rules.some((rule) => rule.enabled);

  // Rules changed: an old preview no longer describes what Apply would do.
  useEffect(() => {
    setPreview(null);
  }, [rules]);

  const check = async () => {
    setLoading(true);
    try {
      setPreview(await previewApplyWaivers());
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not check transactions', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    setApplying(true);
    try {
      const result = await applyWaivers();
      toast({ variant: 'success', title: `${result.waived} transaction${result.waived === 1 ? '' : 's'} marked no receipt needed` });
      setPreview(null);
      onApplied();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not apply rules', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setApplying(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Apply to existing transactions</CardTitle>
        <CardDescription>Rules cover new transactions automatically. Run them over ones already missing a receipt.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {preview ? (
          preview.count === 0 ? (
            <p className="text-sm text-dim">Nothing to change — no missing-receipt transactions match your rules.</p>
          ) : (
            <div className="grid gap-2 rounded-lg bg-[hsl(var(--color-sunken))] p-3">
              <div className="text-sm">
                <span className="font-bold">{preview.count} transaction{preview.count === 1 ? '' : 's'}</span>
                {' '}({fmt$(preview.totalCents / 100)}) would be marked no receipt needed.
              </div>
              {preview.byRule.length > 1 && (
                <ul className="grid gap-0.5 text-xs text-dim">
                  {preview.byRule.map((row) => (
                    <li key={row.ruleId}>{row.label}: {row.count}</li>
                  ))}
                </ul>
              )}
            </div>
          )
        ) : null}
        <div className="flex flex-wrap gap-2">
          {preview && preview.count > 0 ? (
            <>
              <Button disabled={applying} onClick={apply}>
                {applying && <Loader2 className="h-4 w-4 animate-spin" />}
                Apply to {preview.count}
              </Button>
              <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
            </>
          ) : (
            <Button variant="outline" disabled={loading || !anyEnabled} onClick={check}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {anyEnabled ? 'Check existing transactions' : 'Turn on a rule first'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ruleTitle(rule: ReceiptWaiverRule): string {
  if (rule.kind === 'merchant') return rule.merchantLabel ?? rule.label.replace(/^Merchant: /, '');
  if (rule.kind === 'category') return rule.categoryName ?? rule.label.replace(/^Category: /, '');
  return rule.label;
}
