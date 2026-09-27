import { useEffect, useState } from 'react';
import { getAutomationSummary } from '@/api/automation';
import type { AutomationSummary } from '@/types/automation';
import { automationLineParts } from '@/lib/reviewGroups';
import { LearnedRulesSheet } from '../review/LearnedRules';

const DAYS = 7;

/**
 * One quiet sentence under Needs you: "Last 7 days: 23 handled automatically · 2 rules learned".
 * "rules learned" opens the digest where each can be undone. Renders nothing until there is
 * something to say (and on error — it's reassurance, not a task).
 */
export function AutomationLine({ onChanged }: { onChanged?: () => void }) {
  const [summary, setSummary] = useState<AutomationSummary | null>(null);
  const [digestOpen, setDigestOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getAutomationSummary({ days: DAYS })
      .then((result) => !cancelled && setSummary(result))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (!summary) return null;
  const parts = automationLineParts(summary);
  if (!parts.handled && !parts.learned) return null;
  const days = summary.period.days || DAYS;

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 border-t border-ink2/10 px-4 py-2 text-xs text-dim">
      <span>Last {days} days:</span>
      {parts.handled && <span>{parts.handled}</span>}
      {parts.handled && parts.learned && <span aria-hidden="true">·</span>}
      {parts.learned && (
        <button
          type="button"
          onClick={() => setDigestOpen(true)}
          className="-my-2 inline-flex min-h-10 items-center font-bold text-ink underline decoration-ink2/30 underline-offset-2 hover:decoration-ink sm:min-h-0 sm:py-2"
        >
          {parts.learned}
        </button>
      )}
      <LearnedRulesSheet
        open={digestOpen}
        onOpenChange={setDigestOpen}
        days={days}
        onChanged={() => {
          setReloadKey((key) => key + 1);
          onChanged?.();
        }}
      />
    </div>
  );
}
