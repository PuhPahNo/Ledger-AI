import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { resolveCategorizationReviewItem } from '@/api';
import type { Business, CategorizationReviewItem } from '@/types/domain';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ReviewItemCard } from './review/ReviewItemCard';

interface Props {
  open: boolean;
  items: CategorizationReviewItem[];
  businesses: Business[];
  onClose: () => void;
  onResolved: () => void;
}

export function CategorizationReviewCenter({ open, items, businesses, onClose, onResolved }: Props) {
  const { toast } = useToast();
  const [resolving, setResolving] = useState<string | null>(null);
  const businessByKey = useMemo(() => new Map(businesses.map((business) => [business.id, business])), [businesses]);
  const aiSuggestions = items.filter((item) => item.type === 'ai_category_suggestion');

  const resolve = async (item: CategorizationReviewItem, action: 'accept' | 'dismiss') => {
    setResolving(item.id);
    try {
      const result = await resolveCategorizationReviewItem(item.id, action);
      toast({
        variant: action === 'accept' ? 'success' : 'default',
        title: action === 'accept' ? 'Applied' : 'Dismissed',
        description: result.appliedCount > 0
          ? `${result.appliedCount} transaction${result.appliedCount === 1 ? '' : 's'} updated.`
          : undefined,
      });
      onResolved();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Review update failed',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setResolving(null);
    }
  };

  const acceptAiSuggestions = async () => {
    for (const item of aiSuggestions) {
      await resolve(item, 'accept');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg" className="gap-5">
        <DialogHeader>
          <DialogTitle>Notifications</DialogTitle>
          <DialogDescription>
            {items.length ? `${items.length} categorization item${items.length === 1 ? '' : 's'} waiting` : 'No categorization items waiting'}
          </DialogDescription>
        </DialogHeader>

        {aiSuggestions.length > 1 && (
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" onClick={acceptAiSuggestions} disabled={Boolean(resolving)}>
              <Sparkles className="h-3.5 w-3.5" />
              Accept AI suggestions
            </Button>
          </div>
        )}

        <div className="grid max-h-[62vh] gap-3 overflow-auto pr-1">
          {items.length === 0 ? (
            <div className="rounded-lg border border-ink2/10 bg-cream/60 p-5 text-sm text-dim">
              You are caught up.
            </div>
          ) : items.map((item) => (
            <ReviewItemCard
              key={item.id}
              item={item}
              business={businessByKey.get(item.biz)}
              disabled={resolving === item.id}
              onResolve={resolve}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
