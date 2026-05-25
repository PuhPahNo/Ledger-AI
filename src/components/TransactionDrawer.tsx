import { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { updateTransaction } from '@/api';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import type { Business, Category, Transaction } from '@/types/domain';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyDisplay } from '@/components/ui/money-display';

interface Props {
  transaction: Transaction | null;
  businesses: Business[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}

export function TransactionDrawer({ transaction, businesses, categories, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const resolvedBusinessId = useMemo(() => {
    if (!transaction) return '';
    return transaction.businessId ?? businesses.find((business) => business.id === transaction.biz)?.dbId ?? '';
  }, [businesses, transaction]);
  const [businessId, setBusinessId] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBusinessId(resolvedBusinessId);
    setCategoryId(transaction?.categoryId ?? '');
    setNote(transaction?.note ?? '');
  }, [resolvedBusinessId, transaction]);

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
    <Sheet open={Boolean(transaction)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        {transaction && (
          <>
            <SheetHeader>
              <span className="text-xs font-bold uppercase tracking-wider text-dim">{transaction.dateLabel}</span>
              <SheetTitle className="text-2xl">{transaction.merchant}</SheetTitle>
              <SheetDescription className="flex items-center gap-2">
                <Badge variant="muted">{transaction.cat || 'Uncategorized'}</Badge>
                <Badge variant={receiptVariant(transaction.receipt)}>{transaction.receipt}</Badge>
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
              <div className="flex justify-between">
                <span className="text-dim">Receipt status</span>
                <span className="font-bold">{transaction.receipt}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Source</span>
                <span className="font-bold">{transaction.src}</span>
              </div>
            </div>

            <div className="mt-auto flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose}>
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
