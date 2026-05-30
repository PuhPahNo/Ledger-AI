import { useRef, useState } from 'react';
import { Check, Loader2, Send, Sparkles, Wrench } from 'lucide-react';
import { confirmAssistantAction, sendAssistantMessage, uploadReceipt } from '@/api';
import type {
  AssistantApprovalRequest,
  AssistantArtifact,
  AssistantResponse,
  AssistantToolEvent,
  CurrentUser,
} from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { fmt$ } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useToast } from '@/hooks/useToast';
import { AppShell } from './AppShell';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Props {
  user?: CurrentUser;
  onViewChange?: (view: AppView) => void;
  onLogout?: () => void;
}

type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | {
      id: string;
      role: 'assistant';
      text: string;
      artifacts: AssistantArtifact[];
      approvals: AssistantApprovalRequest[];
      toolEvents: AssistantToolEvent[];
      followUps: string[];
    };

interface LiveState {
  statuses: string[];
  toolEvents: AssistantToolEvent[];
}

const examples = [
  'Compare March 2026 inflow versus March 2025 and break it down by business.',
  'What were the largest Draft Sharks Entertainment purchases?',
  'Show current bank balances, but separate credit cards.',
  'Find uncategorized operating spend over $500 this quarter.',
];

export function AssistantPage({ user, onViewChange, onLogout }: Props) {
  const { toast } = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<LiveState>({ statuses: [], toolEvents: [] });
  const [previousResponseId, setPreviousResponseId] = useState<string | null>(null);
  const lastUserMessage = useRef('');

  const ask = async (message: string, approvedDataToken?: string) => {
    const trimmed = message.trim();
    if (!trimmed || busy) return;
    lastUserMessage.current = trimmed;
    setDraft('');
    setBusy(true);
    setLive({ statuses: [], toolEvents: [] });
    if (!approvedDataToken) {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', text: trimmed }]);
    }
    try {
      const response = await sendAssistantMessage({
        message: trimmed,
        previousResponseId,
        approvedDataToken,
      }, (event) => {
        if (event.type === 'status') {
          setLive((current) => ({ ...current, statuses: [...current.statuses.slice(-3), event.message] }));
        }
        if (event.type === 'tool_event') {
          setLive((current) => ({ ...current, toolEvents: [...current.toolEvents, event.event] }));
        }
      });
      setPreviousResponseId(response.nextResponseId);
      appendAssistant(response);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Assistant failed',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setBusy(false);
      setLive({ statuses: [], toolEvents: [] });
    }
  };

  const appendAssistant = (response: AssistantResponse) => {
    setMessages((current) => [...current, {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: response.answer,
      artifacts: response.artifacts,
      approvals: response.approvalRequests,
      toolEvents: response.toolEvents,
      followUps: response.followUpSuggestions,
    }]);
  };

  const confirm = async (approval: AssistantApprovalRequest) => {
    if (approval.kind === 'data_expansion') {
      await ask(lastUserMessage.current, approval.token);
      return;
    }
    try {
      setBusy(true);
      const result = await confirmAssistantAction(approval.token);
      appendAssistant({
        answer: result.message,
        artifacts: result.artifact ? [result.artifact] : [],
        approvalRequests: [],
        followUpSuggestions: [],
        toolEvents: [],
        nextResponseId: previousResponseId,
      });
      toast({ variant: 'success', title: 'Confirmed', description: result.message });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Confirmation failed',
        description: error instanceof Error ? error.message : 'Ask the assistant to prepare it again.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (file: File) => {
    try {
      await uploadReceipt(file);
      toast({ variant: 'success', title: 'Receipt queued', description: 'OCR and matching will run in the background.' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Upload failed', description: error instanceof Error ? error.message : 'Try again.' });
    }
  };

  return (
    <AppShell
      currentView="assistant"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      onUploadReceipt={handleUpload}
      contextEyebrow="Workspace"
      contextTitle="Assistant"
    >
      <div className="flex min-h-[calc(100vh-120px)] flex-col gap-4">
        <main className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[280px_1fr]">
          <aside className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-lemon text-ink">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <h1 className="font-display text-xl font-bold">Assistant</h1>
                <p className="text-xs text-dim">Cash-basis Ledger AI analyst</p>
              </div>
            </div>
            <div className="mt-5 space-y-2">
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="w-full rounded-lg border border-ink2/10 bg-cream/60 px-3 py-2 text-left text-sm transition hover:bg-lemon/25"
                  onClick={() => ask(example)}
                  disabled={busy}
                >
                  {example}
                </button>
              ))}
            </div>
            <div className="mt-5 rounded-lg bg-ink px-3 py-3 text-xs leading-relaxed text-cream">
              Mutations require confirmation. Expanded transaction detail requires approval. Raw provider payloads and secrets are blocked.
            </div>
          </aside>

          <section className="flex min-h-0 flex-col rounded-xl border border-ink2/10 bg-paper shadow-sm">
            <div className="border-b border-ink2/10 px-4 py-3">
              <div className="font-display text-lg font-bold">Ask anything about finances</div>
              <div className="text-sm text-dim">Transactions, balances, cash flow, receipts, categories, and owner insights.</div>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
              {messages.length === 0 && (
                <div className="mx-auto max-w-2xl py-16 text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-lemon text-ink">
                    <Sparkles className="h-7 w-7" />
                  </div>
                  <h2 className="font-display text-3xl font-bold">What do you want to know?</h2>
                  <p className="mt-2 text-dim">Try a multi-step question. I’ll show tool calls as I work, then render charts or tables inside the chat.</p>
                </div>
              )}
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} onConfirm={confirm} onAsk={ask} busy={busy} />
              ))}
              {busy && <LiveToolCallPanel live={live} />}
            </div>

            <form
              className="border-t border-ink2/10 p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void ask(draft);
              }}
            >
              <div className="flex items-end gap-2 rounded-xl border border-ink2/15 bg-cream/70 p-2">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Ask about cash flow, top purchases, balances, pairing receipts, or categorization cleanup..."
                  className="max-h-36 min-h-[52px] flex-1 resize-none border-transparent bg-transparent shadow-none focus-visible:border-transparent focus-visible:ring-0"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void ask(draft);
                    }
                  }}
                />
                <Button type="submit" disabled={busy || !draft.trim()} className="mb-1">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Send
                </Button>
              </div>
            </form>
          </section>
        </main>
      </div>
    </AppShell>
  );
}

function MessageBubble({
  message,
  onConfirm,
  onAsk,
  busy,
}: {
  message: ChatMessage;
  onConfirm: (approval: AssistantApprovalRequest) => void;
  onAsk: (message: string) => void;
  busy: boolean;
}) {
  if (message.role === 'user') {
    return (
      <div className="ml-auto max-w-3xl rounded-xl bg-ink px-4 py-3 text-paper">
        <RichText text={message.text} invert />
      </div>
    );
  }
  return (
    <div className="max-w-5xl space-y-3">
      <div className="rounded-xl border border-ink2/10 bg-cream/60 px-4 py-3">
        <RichText text={message.text} />
      </div>
      {message.toolEvents.length > 0 && <ToolEventStrip events={message.toolEvents} />}
      {message.artifacts.map((artifact) => <ArtifactView key={artifact.id} artifact={artifact} />)}
      {message.approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} onConfirm={onConfirm} busy={busy} />
      ))}
      {message.followUps.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {message.followUps.map((followUp) => (
            <Button key={followUp} type="button" variant="outline" size="sm" onClick={() => onAsk(followUp)} disabled={busy}>
              {followUp}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function RichText({ text, invert = false }: { text: string; invert?: boolean }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className={cn('space-y-2 text-sm leading-relaxed', invert ? 'text-paper' : 'text-ink')}>
      {blocks.map((block, index) => {
        const lines = block.split('\n').filter(Boolean);
        const isList = lines.every((line) => /^[-*]\s+/.test(line.trim()));
        if (isList) {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {lines.map((line) => <li key={line}>{inline(line.replace(/^[-*]\s+/, ''))}</li>)}
            </ul>
          );
        }
        return <p key={index}>{inline(block)}</p>;
      })}
    </div>
  );
}

function inline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    return <span key={index}>{part}</span>;
  });
}

function LiveToolCallPanel({ live }: { live: LiveState }) {
  const currentStatus = live.statuses.at(-1) ?? 'Working through the Ledger AI tools.';
  return (
    <div className="max-w-4xl rounded-xl border border-lemon/50 bg-lemon/15 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Loader2 className="h-4 w-4 animate-spin" />
        {currentStatus}
      </div>
      {live.toolEvents.length > 0 && <ToolEventStrip events={live.toolEvents} compact />}
    </div>
  );
}

function ToolEventStrip({ events, compact = false }: { events: AssistantToolEvent[]; compact?: boolean }) {
  return (
    <div className={cn('flex flex-wrap gap-2', compact && 'mt-3')}>
      {events.slice(-8).map((event, index) => (
        <Badge
          key={`${event.name}-${event.status}-${index}`}
          variant={event.status === 'failed' ? 'danger' : event.status === 'succeeded' ? 'success' : 'secondary'}
          className="gap-1"
        >
          <Wrench className="h-3 w-3" />
          {event.detail}
        </Badge>
      ))}
    </div>
  );
}

function ApprovalCard({ approval, onConfirm, busy }: { approval: AssistantApprovalRequest; onConfirm: (approval: AssistantApprovalRequest) => void; busy: boolean }) {
  return (
    <div className="rounded-xl border border-coral/35 bg-coral/10 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <div className="font-display text-lg font-bold">{approval.title}</div>
          <p className="mt-1 text-sm text-dim">{approval.detail}</p>
          <p className="mt-2 text-xs text-dim">Expires {new Date(approval.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
        </div>
        <Button onClick={() => onConfirm(approval)} disabled={busy}>
          <Check className="h-4 w-4" />
          {approval.buttonLabel}
        </Button>
      </div>
    </div>
  );
}

function ArtifactView({ artifact }: { artifact: AssistantArtifact }) {
  if (artifact.type === 'metric_grid') return <MetricGrid artifact={artifact} />;
  if (artifact.type === 'chart') return <ChartArtifact artifact={artifact} />;
  if (artifact.type === 'transactions') return <TransactionsArtifact artifact={artifact} />;
  return <TableArtifact artifact={artifact} />;
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
