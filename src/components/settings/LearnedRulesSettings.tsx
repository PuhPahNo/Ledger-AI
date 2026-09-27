import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getAutomationSettings, updateAutomationSettings } from '@/api/automation';
import type { AutomationSettings } from '@/types/automation';
import { useToast } from '@/hooks/useToast';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { LearnedRulesList } from '../review/LearnedRules';

const LEARNED_DAYS = 90;

/** Settings › Categories & rules › Learned: the two automation knobs, then every learned rule. */
export function LearnedRulesSettings() {
  return (
    <div className="grid gap-3">
      <AutomationSettingsCard />
      <Card className="grid gap-3 p-4 sm:p-5">
        <div>
          <h3 className="font-display text-base font-bold text-ink">Learned rules</h3>
          <p className="text-xs text-dim">Last {LEARNED_DAYS} days. Undo removes the rule and restores what it relabelled.</p>
        </div>
        <LearnedRulesList days={LEARNED_DAYS} />
      </Card>
    </div>
  );
}

function range(min: number, max: number, step = 1): number[] {
  const values: number[] = [];
  for (let value = min; value <= max + 1e-9; value += step) values.push(Math.round(value * 100) / 100);
  return values;
}

function AutomationSettingsCard() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getAutomationSettings().then(setSettings).catch((loadError: Error) => setError(loadError.message));
  }, []);

  const save = async (patch: Partial<Pick<AutomationSettings, 'autoLearnMinCorrections' | 'externalSignalAutoApplyConfidence'>>) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setSaving(true);
    try {
      setSettings(await updateAutomationSettings(patch));
      toast({ variant: 'success', title: 'Automation updated' });
    } catch (saveError) {
      setSettings(previous);
      toast({ variant: 'destructive', title: 'Save failed', description: saveError instanceof Error ? saveError.message : 'Try again.' });
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return <div role="alert" className="rounded-lg border border-coral/30 bg-coral/10 p-3 text-sm font-bold text-coral-ink">Couldn't load automation settings: {error}</div>;
  }
  if (!settings) return <Skeleton className="h-28" />;

  const corrections = settings.limits.autoLearnMinCorrections;
  const confidence = settings.limits.externalSignalAutoApplyConfidence;
  const confidenceSteps = range(Math.ceil(confidence.min * 20) / 20, confidence.max, 0.05);
  if (!confidenceSteps.includes(settings.externalSignalAutoApplyConfidence)) {
    confidenceSteps.push(settings.externalSignalAutoApplyConfidence);
    confidenceSteps.sort((a, b) => a - b);
  }

  return (
    <Card className="grid gap-1 p-4 sm:p-5">
      <h3 className="font-display text-base font-bold text-ink">Automation</h3>
      <SettingRow
        label="Learn a rule after"
        hint="Matching corrections of the same merchant before a rule is learned for you."
      >
        <Select
          value={String(settings.autoLearnMinCorrections)}
          disabled={saving}
          onValueChange={(value) => void save({ autoLearnMinCorrections: Number(value) })}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Corrections before learning a rule">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {range(corrections.min, corrections.max).map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value} correction{value === 1 ? '' : 's'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        label="Auto-apply QuickBooks categories at"
        hint="Below this, a QuickBooks category becomes a suggestion in Needs you. Never overrides what you set."
      >
        <Select
          value={String(settings.externalSignalAutoApplyConfidence)}
          disabled={saving}
          onValueChange={(value) => void save({ externalSignalAutoApplyConfidence: Number(value) })}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="QuickBooks auto-apply confidence">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {confidenceSteps.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value >= 1 ? 'Only when certain' : `≥ ${Math.round(value * 100)}% sure`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </Card>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-ink2/10 py-2.5 first-of-type:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="text-sm font-bold text-ink">{label}</div>
        <div className="text-xs text-dim">{hint}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
