import { useEffect, useMemo, useState } from 'react';
import { Plus, Save } from 'lucide-react';
import {
  addTransactionTag,
  removeTransactionTag,
  updateTransaction,
} from '@/api';
import { categorySourceLabel, isGuessedCategorySource } from '@/lib/categorySource';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import type { Business, Category, ReceiptInboxItem, ReceiptStatus, Tag, Transaction, TransactionTag } from '@/types/domain';
import { TagChip } from '@/components/ui/tag-chip';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyDisplay } from '@/components/ui/money-display';
import { TransactionReceiptPanel } from './receipts/TransactionReceiptPanel';
import { QuickbooksTransactionPanel } from './quickbooks/QuickbooksTransactionPanel';

interface Props {
  transaction: Transaction | null;
  businesses: Business[];
  categories: Category[];
  /** Available custom tags; omit to hide the tags editor. */
  allTags?: Tag[];
  onClose: () => void;
  onSaved: () => void;
}

export function TransactionDrawer({ transaction, businesses, categories, allTags, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const resolvedBusinessId = useMemo(() => {
    if (!transaction) return '';
    return transaction.businessId ?? businesses.find((business) => business.id === transaction.biz)?.dbId ?? '';
  }, [businesses, transaction]);
  const [businessId, setBusinessId] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [tags, setTags] = useState<TransactionTag[]>([]);
  const [tagBusy, setTagBusy] = useState(false);
  const [tagsDirty, setTagsDirty] = useState(false);
  // The receipt slot; attach/unpair/waive apply immediately, like tag edits.
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [receiptStatus, setReceiptStatus] = useState<ReceiptStatus>('missing');
  const [receiptDirty, setReceiptDirty] = useState(false);
  const [knownReceipt, setKnownReceipt] = useState<ReceiptInboxItem | null>(null);

  useEffect(() => {
    setBusinessId(resolvedBusinessId);
    setCategoryId(transaction?.categoryId ?? '');
    setNote(transaction?.note ?? '');
    setTags(transaction?.tags ?? []);
    setTagsDirty(false);
    setReceiptId(transaction?.receiptId ?? null);
    setReceiptStatus(transaction?.receipt ?? 'missing');
    setReceiptDirty(false);
    setKnownReceipt(null);
  }, [resolvedBusinessId, transaction]);

  // Tag/receipt edits apply immediately (no Save needed), so refresh the list when closing after one.
  const close = () => {
    if (tagsDirty || receiptDirty) onSaved();
    onClose();
  };

  const businessName = useMemo(
    () => businesses.find((business) => business.dbId === resolvedBusinessId || business.id === transaction?.biz)?.name,
    [businesses, resolvedBusinessId, transaction?.biz],
  );

  const addableTags = (allTags ?? []).filter(
    (tag) => tag.active && !tags.some((applied) => applied.id === tag.id),
  );

  const handleAddTag = async (tagId: string) => {
    if (!transaction) return;
    setTagBusy(true);
    try {
      const result = await addTransactionTag(transaction.id, tagId);
      setTags(result.tags);
      setTagsDirty(true);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Could not add tag',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setTagBusy(false);
    }
  };

  const handleRemoveTag = async (tagId: string) => {
    if (!transaction) return;
    setTagBusy(true);
    try {
      await removeTransactionTag(transaction.id, tagId);
      setTags((current) => current.filter((tag) => tag.id !== tagId));
      setTagsDirty(true);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Could not remove tag',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setTagBusy(false);
    }
  };

  const save = async () => {
    if (!transaction) return;
    setSaving(true);
    try {
      await updateTransaction(transaction.id, {
        businessId: businessId || undefined,
        categoryId: categoryId || null,
        note: note || null,
      });
      toast({
        variant: 'success',
        title: 'Transaction saved',
        description: categoryId && categoryId !== transaction.categoryId ? 'Learning question added to Notifications.' : undefined,
      });
      onSaved();
      onClose();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={Boolean(transaction)} onOpenChange={(open) => !open && close()}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        {transaction && (
          <>
            <SheetHeader>
              <span className="text-xs font-bold uppercase tracking-wider text-dim">{transaction.dateLabel}</span>
              <SheetTitle className="text-2xl">{transaction.merchant}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <Badge variant="muted">{transaction.cat || 'Uncategorized'}</Badge>
                <Badge variant={receiptVariant(receiptStatus)}>{receiptStatusLabel(receiptStatus)}</Badge>
              </SheetDescription>
            </SheetHeader>

            <MoneyDisplay size="xl" className={transaction.amount > 0 ? 'text-sage-ink' : 'text-ink'}>
              {fmt$(transaction.amount)}
            </MoneyDisplay>

            <Separator />

            <div className="grid gap-1.5">
              <Label htmlFor="drawer-business">Business</Label>
              <Select value={businessId} onValueChange={setBusinessId}>
                <SelectTrigger id="drawer-business">
                  <SelectValue placeholder="Choose a business" />
                </SelectTrigger>
                <SelectContent>
                  {businesses.map((business) => (
                    <SelectItem key={business.dbId ?? business.id} value={business.dbId ?? business.id}>
                      {business.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="drawer-category">Category</Label>
              <Select value={categoryId || 'uncategorized'} onValueChange={(value) => setCategoryId(value === 'uncategorized' ? '' : value)}>
                <SelectTrigger id="drawer-category">
                  <SelectValue placeholder="Uncategorized" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="uncategorized">Uncategorized</SelectItem>
                  {categories.map((category) => (
                    <SelectItem key={category.id ?? category.name} value={category.id ?? category.name}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {allTags && (
              <div className="grid gap-1.5">
                <Label>Tags</Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {tags.map((tag) => (
                    <TagChip
                      key={tag.id}
                      name={tag.name}
                      color={tag.color}
                      title={tag.source === 'auto' ? 'Applied automatically by a tag rule' : 'Applied manually'}
                      onRemove={tagBusy ? undefined : () => handleRemoveTag(tag.id)}
                    />
                  ))}
                  {tags.length === 0 && <span className="text-xs text-dim">No tags yet.</span>}
                </div>
                {addableTags.length > 0 && (
                  <Select value="" onValueChange={handleAddTag} disabled={tagBusy}>
                    <SelectTrigger className="h-8 w-44 text-xs">
                      <span className="inline-flex items-center gap-1 text-dim">
                        <Plus className="h-3 w-3" />
                        Add tag
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {addableTags.map((tag) => (
                        <SelectItem key={tag.id} value={tag.id}>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: tag.color }} />
                            {tag.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            <TransactionReceiptPanel
              transaction={transaction}
              receiptId={receiptId}
              status={receiptStatus}
              receipt={knownReceipt}
              businessName={businessName}
              onChange={(next) => {
                setKnownReceipt(next.receipt ?? null);
                setReceiptId(next.receiptId);
                setReceiptStatus(next.status);
                setReceiptDirty(true);
              }}
            />

            <QuickbooksTransactionPanel transactionId={transaction.id} business={transaction.biz} />

            <div className="grid gap-1.5">
              <Label htmlFor="drawer-note">Note</Label>
              <Textarea
                id="drawer-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={4}
                placeholder="Add context for tax season"
              />
            </div>

            <div className="grid gap-1.5 rounded-md bg-[hsl(var(--color-sunken))] p-3 text-xs">
              {categorySourceLabel(transaction.categorySource) && (
                <div className="flex justify-between">
                  <span className="text-dim">Categorized by</span>
                  <span className="font-bold">
                    {categorySourceLabel(transaction.categorySource)}
                    {transaction.categoryConfidence != null
                      && isGuessedCategorySource(transaction.categorySource)
                      && ` · ${Math.round(transaction.categoryConfidence * 100)}%`}
                  </span>
                </div>
              )}
              {categoryReason(transaction) && (
                <div className="text-[11px] leading-snug text-dim">{categoryReason(transaction)}</div>
              )}
              <div className="flex justify-between">
                <span className="text-dim">Source</span>
                <span className="font-bold">{transaction.src}</span>
              </div>
            </div>

            <div className="mt-auto flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                <Save className="h-4 w-4" />
                {saving ? 'Saving…' : 'Save overrides'}
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Pull a human-readable "why" out of the categorization evidence, when one exists. */
function categoryReason(transaction: Transaction): string | null {
  const evidence = transaction.categoryEvidence;
  if (!evidence) return null;
  const reason = evidence.reason;
  if (typeof reason === 'string' && reason.length > 0 && !reason.includes('_')) return reason;
  if (typeof evidence.pattern === 'string') return `Matched rule pattern "${evidence.pattern}"`;
  return null;
}

function receiptStatusLabel(status: ReceiptStatus): string {
  switch (status) {
    case 'matched':
      return 'Receipt attached';
    case 'pending':
      return 'Receipt to confirm';
    case 'missing':
      return 'Receipt missing';
    case 'waived':
      return 'No receipt needed';
    default:
      return 'No receipt';
  }
}

function receiptVariant(status: Transaction['receipt']): 'success' | 'warning' | 'danger' | 'muted' {
  switch (status) {
    case 'matched':
      return 'success';
    case 'pending':
      return 'warning';
    case 'missing':
      return 'danger';
    default:
      return 'muted';
  }
}
