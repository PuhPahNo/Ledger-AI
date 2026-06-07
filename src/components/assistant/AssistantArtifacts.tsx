import type { AssistantArtifact, AssistantArtifactAction } from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/cn';
import { fmt$ } from '@/lib/format';

export function ArtifactView({ artifact, onViewChange }: { artifact: AssistantArtifact; onViewChange?: (view: AppView) => void }) {
  return (
    <div className="space-y-2">
      {artifact.type === 'metric_grid' && <MetricGrid artifact={artifact} />}
      {artifact.type === 'chart' && <ChartArtifact artifact={artifact} />}
      {artifact.type === 'transactions' && <TransactionsArtifact artifact={artifact} />}
      {artifact.type === 'table' && <TableArtifact artifact={artifact} />}
      <ArtifactEvidence artifact={artifact} onViewChange={onViewChange} />
    </div>
  );
}

function ArtifactEvidence({ artifact, onViewChange }: { artifact: AssistantArtifact; onViewChange?: (view: AppView) => void }) {
  if (!artifact.sources?.length && !artifact.actions?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ink2/10 bg-paper/70 px-3 py-2 text-xs text-dim">
      {artifact.sources?.map((source, index) => (
        <span key={`${source.type}-${index}`} className="font-medium">
          Evidence: {source.ids?.length ?? 0} {sourceLabel(source.type)}
        </span>
      ))}
      <span className="flex-1" />
      {artifact.actions?.map((action) => (
        <Button key={`${action.view}-${action.label}`} type="button" variant="outline" size="sm" onClick={() => handleArtifactAction(action, onViewChange)}>
          {action.label}
        </Button>
      ))}
    </div>
  );
}

function handleArtifactAction(action: AssistantArtifactAction, onViewChange?: (view: AppView) => void) {
  onViewChange?.(action.view as AppView);
}

function sourceLabel(type: string): string {
  switch (type) {
    case 'transactions':
      return 'transaction rows';
    case 'receipts':
      return 'receipt rows';
    case 'cash_flow':
      return 'cash-flow periods';
    case 'owner_insights':
      return 'owner insight rows';
    default:
      return 'source rows';
  }
}

function MetricGrid({ artifact }: { artifact: Extract<AssistantArtifact, { type: 'metric_grid' }> }) {
  return (
    <div className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
      <h3 className="font-display text-lg font-bold">{artifact.title}</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {artifact.metrics.map((metric) => (
          <div key={metric.label} className="rounded-lg border border-ink2/10 bg-cream/60 p-3">
            <div className="text-xs font-medium uppercase tracking-wider text-dim">{metric.label}</div>
            <div className={cn('mt-1 font-display text-2xl font-bold', toneClass(metric.tone))}>{metric.value}</div>
            {metric.detail && <div className="mt-1 text-xs text-dim">{metric.detail}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartArtifact({ artifact }: { artifact: Extract<AssistantArtifact, { type: 'chart' }> }) {
  const max = Math.max(1, ...artifact.series.flatMap((series) => series.values.map((value) => Math.abs(value))));
  if (artifact.chartType === 'donut') return <DonutChart artifact={artifact} max={max} />;
  return (
    <div className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-lg font-bold">{artifact.title}</h3>
        <div className="flex flex-wrap gap-2">
          {artifact.series.map((series) => (
            <span key={series.name} className="flex items-center gap-1 text-xs text-dim">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: series.color ?? '#111' }} />
              {series.name}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-4 flex h-64 items-end gap-2 overflow-x-auto border-b border-ink2/15 pb-2">
        {artifact.labels.map((label, labelIndex) => (
          <div key={label} className="flex min-w-12 flex-1 flex-col items-center gap-2">
            <div className="flex h-52 w-full items-end justify-center gap-1">
              {artifact.series.map((series) => {
                const value = series.values[labelIndex] ?? 0;
                const height = Math.max(4, Math.round((Math.abs(value) / max) * 200));
                return (
                  <div
                    key={series.name}
                    className="w-full max-w-6 rounded-t-md"
                    title={`${series.name}: ${formatValue(value, artifact.valueType)}`}
                    style={{ height, background: series.color ?? '#111' }}
                  />
                );
              })}
            </div>
            <div className="max-w-16 truncate text-center text-[11px] text-dim">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DonutChart({ artifact, max }: { artifact: Extract<AssistantArtifact, { type: 'chart' }>; max: number }) {
  const values = artifact.series[0]?.values ?? [];
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || max;
  return (
    <div className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
      <h3 className="font-display text-lg font-bold">{artifact.title}</h3>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {artifact.labels.map((label, index) => {
          const value = values[index] ?? 0;
          return (
            <div key={label} className="flex items-center gap-3">
              <div className="h-3 rounded-full" style={{ width: `${Math.max(8, (value / total) * 180)}px`, background: artifact.series[index]?.color ?? '#D97757' }} />
              <span className="text-sm">{label}</span>
              <span className="ml-auto font-semibold">{formatValue(value, artifact.valueType)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TransactionsArtifact({ artifact }: { artifact: Extract<AssistantArtifact, { type: 'transactions' }> }) {
  return (
    <div className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
      <h3 className="font-display text-lg font-bold">{artifact.title}</h3>
      <Table className="mt-3">
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Merchant</TableHead>
            <TableHead>Business</TableHead>
            <TableHead>Category</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {artifact.rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="whitespace-nowrap">{row.date}</TableCell>
              <TableCell className="max-w-[280px] truncate font-medium">{row.merchant}</TableCell>
              <TableCell>{row.business}</TableCell>
              <TableCell>{row.category}</TableCell>
              <TableCell className="text-right font-semibold">{fmt$(row.amountCents / 100)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TableArtifact({ artifact }: { artifact: Extract<AssistantArtifact, { type: 'table' }> }) {
  return (
    <div className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
      <h3 className="font-display text-lg font-bold">{artifact.title}</h3>
      <Table className="mt-3">
        <TableHeader>
          <TableRow>
            {artifact.columns.map((column) => <TableHead key={column.key} className={column.align === 'right' ? 'text-right' : ''}>{column.label}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {artifact.rows.map((row, index) => (
            <TableRow key={index}>
              {artifact.columns.map((column, columnIndex) => (
                <TableCell key={column.key} className={column.align === 'right' ? 'text-right' : ''}>
                  {row.cells[columnIndex] ?? ''}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function toneClass(tone: string) {
  if (tone === 'positive') return 'text-emerald-700';
  if (tone === 'warning') return 'text-coral-ink';
  if (tone === 'danger') return 'text-red-700';
  if (tone === 'muted') return 'text-dim';
  return 'text-ink';
}

function formatValue(value: number, type: 'currency_cents' | 'count' | 'percent') {
  if (type === 'currency_cents') return fmt$(value / 100);
  if (type === 'percent') return `${value}%`;
  return Math.round(value).toLocaleString();
}
