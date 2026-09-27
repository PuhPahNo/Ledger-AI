import { useEffect, useState } from 'react';
import { listBusinesses, uploadReceipt } from '@/api';
import type { Business, CurrentUser } from '@/types/domain';
import type { NavigateFn, ReportsTab, TransactionViewFilters } from '@/types/navigation';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/cn';
import { AppShell } from '../AppShell';
import { REPORT_TABS } from './reportTabs';

interface Props {
  user?: CurrentUser;
  onViewChange?: NavigateFn;
  onLogout?: () => void;
  tab: ReportsTab;
  onTabChange: (tab: ReportsTab) => void;
  onOpenTransactions?: (filters?: TransactionViewFilters) => void;
}

/** Reports (#reports/<tab>): the business switcher is shared; each tab owns its own period. */
export function ReportsPage({ user, onViewChange, onLogout, tab, onTabChange, onOpenTransactions }: Props) {
  const { toast } = useToast();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [business, setBusiness] = useState('all');

  useEffect(() => {
    listBusinesses().then(setBusinesses).catch(() => undefined);
  }, []);

  const handleUpload = async (file: File) => {
    try {
      await uploadReceipt(file, business === 'all' ? undefined : businesses.find((item) => item.id === business)?.dbId);
      toast({ variant: 'success', title: 'Receipt queued', description: 'Reading and matching it now.' });
    } catch (uploadError) {
      toast({ variant: 'destructive', title: 'Upload failed', description: uploadError instanceof Error ? uploadError.message : 'Try again.' });
    }
  };

  const active = REPORT_TABS.find((item) => item.id === tab) ?? REPORT_TABS[0];
  const Tab = active.component;

  return (
    <AppShell
      currentView="reports"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      onUploadReceipt={handleUpload}
      contextEyebrow="Reports"
      contextTitle={active.label}
      businesses={businesses}
      selectedBusiness={business}
      onBusinessChange={setBusiness}
    >
      <div className="flex flex-col gap-3">
        <div role="tablist" aria-label="Reports" className="flex w-full overflow-x-auto rounded-full bg-paper p-1 shadow-xs sm:w-fit">
          {REPORT_TABS.map((item) => {
            const selected = item.id === active.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => !selected && onTabChange(item.id)}
                className={cn(
                  'inline-flex min-h-10 flex-1 items-center justify-center rounded-full px-4 text-xs font-bold transition-colors sm:min-h-9 sm:flex-none',
                  selected ? 'bg-inverse text-inverse-foreground' : 'text-dim hover:text-ink',
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        <div role="tabpanel" aria-label={active.label}>
          <Tab business={business} businesses={businesses} onViewChange={onViewChange} onOpenTransactions={onOpenTransactions} />
        </div>
      </div>
    </AppShell>
  );
}
