import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, MessageSquarePlus, Send, Sparkles, Wrench, X } from 'lucide-react';
import { ApiError, confirmAssistantAction, sendAssistantMessage, uploadReceipt } from '@/api';
import type {
  AssistantApprovalRequest,
  AssistantResponse,
  AssistantToolEvent,
  CurrentUser,
} from '@/types/domain';
import { LEDGER_DATA_CHANGED_EVENT, type LedgerDataChangedDetail } from '@/types/assistant';
import type { NavigateFn } from '@/types/navigation';
import { cn } from '@/lib/cn';
import { useToast } from '@/hooks/useToast';
import { AppShell } from './AppShell';
import { ArtifactView } from './assistant/AssistantArtifacts';
import { RichText } from './assistant/RichText';
import {
  clearConversation,
  emptyConversation,
  loadConversation,
  saveConversation,
  type ApprovalStatus,
  type ChatMessage,
} from './assistant/conversationStorage';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

interface Props {
  user?: CurrentUser;
  onViewChange?: NavigateFn;
  onLogout?: () => void;
}

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
  const [initial] = useState(loadConversation);
  const [messages, setMessages] = useState<ChatMessage[]>(initial.messages);
  const [previousResponseId, setPreviousResponseId] = useState<string | null>(initial.previousResponseId);
  const [pendingActionResults, setPendingActionResults] = useState<string[]>(initial.pendingActionResults);
  const [approvalStatus, setApprovalStatus] = useState<Record<string, ApprovalStatus>>(initial.approvalStatus);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<LiveState>({ statuses: [], toolEvents: [] });
  // Synchronous guard against double-clicks landing before React re-renders.
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    saveConversation({ version: 1, messages, previousResponseId, pendingActionResults, approvalStatus });
  }, [messages, previousResponseId, pendingActionResults, approvalStatus]);

  const markApproval = (id: string, status: ApprovalStatus) => {
    setApprovalStatus((current) => ({ ...current, [id]: status }));
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

  /** Run one model turn. `message` is shown as a user bubble unless this is an approval replay. */
  const runTurn = async ({ message, approvedDataToken }: { message: string; approvedDataToken?: string }) => {
    if (busy || inFlight.current.has('turn')) return false;
    inFlight.current.add('turn');
    const actionResults = pendingActionResults;
    setBusy(true);
    setLive({ statuses: [], toolEvents: [] });
    if (!approvedDataToken) {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', text: message }]);
    }
    try {
      const response = await sendAssistantMessage({
        message,
        previousResponseId,
        approvedDataToken,
        actionResults,
      }, (event) => {
        if (event.type === 'status') {
          setLive((current) => ({ ...current, statuses: [...current.statuses.slice(-3), event.message] }));
        }
        if (event.type === 'tool_event') {
          setLive((current) => ({ ...current, toolEvents: [...current.toolEvents, event.event] }));
        }
      });
      setPreviousResponseId(response.nextResponseId);
      // The model has now seen these notes (or the thread was reset); don't resend them.
      setPendingActionResults((current) => current.filter((note) => !actionResults.includes(note)));
      appendAssistant(response);
      return true;
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Assistant failed',
        description: error instanceof Error ? error.message : 'Try again.',
      });
      return false;
    } finally {
      inFlight.current.delete('turn');
      setBusy(false);
      setLive({ statuses: [], toolEvents: [] });
    }
  };

  const ask = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || busy) return;
    setDraft('');
    await runTurn({ message: trimmed });
  };

  const confirm = async (approval: AssistantApprovalRequest) => {
    if (busy || inFlight.current.has(approval.id) || approvalStatus[approval.id]) return;
    if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      markApproval(approval.id, 'expired');
      return;
    }
    inFlight.current.add(approval.id);
    markApproval(approval.id, 'confirming');
    try {
      if (approval.kind === 'data_expansion') {
        // The server replays the question this approval was issued for; no duplicate user turn.
        const ok = await runTurn({ message: '', approvedDataToken: approval.token });
        markApproval(approval.id, 'done');
        if (!ok) toast({ variant: 'destructive', title: 'Approval not applied', description: 'Ask the question again to get a new approval.' });
        return;
      }
      setBusy(true);
      const result = await confirmAssistantAction(approval.token);
      markApproval(approval.id, 'done');
      appendAssistant({
        answer: result.message,
        artifacts: result.artifact ? [result.artifact] : [],
        approvalRequests: [],
        followUpSuggestions: [],
        toolEvents: [],
        nextResponseId: previousResponseId,
      });
      setPendingActionResults((current) => [...current, result.contextNote ?? `Confirmed: ${approval.title}. ${result.message}`]);
      try {
        window.dispatchEvent(new CustomEvent<LedgerDataChangedDetail>(LEDGER_DATA_CHANGED_EVENT, {
          detail: { source: 'assistant', kind: approval.kind },
        }));
      } catch {
        // Non-browser environments; nothing to notify.
      }
      toast({ variant: 'success', title: 'Confirmed', description: result.message });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      // 409: already used elsewhere (other tab / earlier click). 410: expired. Otherwise allow a retry.
      if (status === 409) markApproval(approval.id, 'done');
      else if (status === 410) markApproval(approval.id, 'expired');
      else setApprovalStatus((current) => {
        const next = { ...current };
        delete next[approval.id];
        return next;
      });
      toast({
        variant: 'destructive',
        title: 'Confirmation failed',
        description: error instanceof Error ? error.message : 'Ask the assistant to prepare it again.',
      });
    } finally {
      inFlight.current.delete(approval.id);
      setBusy(false);
    }
  };

  const decline = (approval: AssistantApprovalRequest) => {
    if (approvalStatus[approval.id] || inFlight.current.has(approval.id)) return;
    markApproval(approval.id, 'declined');
    setPendingActionResults((current) => [...current, `The user declined: ${approval.title}. ${approval.detail} Nothing was changed.`]);
  };

  const newChat = () => {
    if (busy) return;
    clearConversation();
    const fresh = emptyConversation();
    setMessages(fresh.messages);
    setPreviousResponseId(fresh.previousResponseId);
    setPendingActionResults(fresh.pendingActionResults);
    setApprovalStatus(fresh.approvalStatus);
    setDraft('');
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
            <div className="mt-5 rounded-lg bg-strong px-3 py-3 text-xs leading-relaxed text-strong-foreground">
              Mutations require confirmation. Expanded transaction detail requires approval. Raw provider payloads and secrets are blocked.
            </div>
          </aside>

          <section className="flex min-h-0 flex-col rounded-xl border border-ink2/10 bg-paper shadow-sm">
            <div className="flex items-start gap-3 border-b border-ink2/10 px-4 py-3">
              <div className="flex-1">
                <div className="font-display text-lg font-bold">Ask anything about finances</div>
                <div className="text-sm text-dim">Transactions, balances, cash flow, receipts, categories, and owner insights.</div>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={newChat} disabled={busy || messages.length === 0}>
                <MessageSquarePlus className="h-4 w-4" />
                New chat
              </Button>
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
                <MessageBubble
                  key={message.id}
                  message={message}
                  approvalStatus={approvalStatus}
                  onConfirm={confirm}
                  onDecline={decline}
                  onAsk={ask}
                  onViewChange={onViewChange}
                  busy={busy}
                />
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
  approvalStatus,
  onConfirm,
  onDecline,
  onAsk,
  onViewChange,
  busy,
}: {
  message: ChatMessage;
  approvalStatus: Record<string, ApprovalStatus>;
  onConfirm: (approval: AssistantApprovalRequest) => void;
  onDecline: (approval: AssistantApprovalRequest) => void;
  onAsk: (message: string) => void;
  onViewChange?: NavigateFn;
  busy: boolean;
}) {
  if (message.role === 'user') {
    return (
      <div className="ml-auto max-w-3xl rounded-xl bg-strong px-4 py-3 text-strong-foreground">
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
      {message.artifacts.map((artifact) => <ArtifactView key={artifact.id} artifact={artifact} onViewChange={onViewChange} />)}
      {message.approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          status={approvalStatus[approval.id]}
          onConfirm={onConfirm}
          onDecline={onDecline}
          busy={busy}
        />
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

function ApprovalCard({
  approval,
  status,
  onConfirm,
  onDecline,
  busy,
}: {
  approval: AssistantApprovalRequest;
  status?: ApprovalStatus;
  onConfirm: (approval: AssistantApprovalRequest) => void;
  onDecline: (approval: AssistantApprovalRequest) => void;
  busy: boolean;
}) {
  const expired = status === 'expired' || (!status && new Date(approval.expiresAt).getTime() <= Date.now());
  const settled = status === 'done' || status === 'declined' || expired;
  const statusLabel = status === 'done'
    ? (approval.kind === 'data_expansion' ? 'Approved' : 'Applied')
    : status === 'declined' ? 'Declined' : expired ? 'Expired' : null;
  return (
    <div className={cn('rounded-xl border p-4', settled ? 'border-ink2/10 bg-cream/40 opacity-80' : 'border-coral/35 bg-coral/10')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <div className="font-display text-lg font-bold">{approval.title}</div>
          <p className="mt-1 text-sm text-dim">{approval.detail}</p>
          {!settled && (
            <p className="mt-2 text-xs text-dim">Expires {new Date(approval.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
          )}
        </div>
        {statusLabel ? (
          <Badge variant={status === 'done' ? 'success' : 'secondary'} className="gap-1">
            {status === 'done' ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {statusLabel}
          </Badge>
        ) : (
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onDecline(approval)} disabled={busy || status === 'confirming'}>
              <X className="h-4 w-4" />
              Decline
            </Button>
            <Button type="button" onClick={() => onConfirm(approval)} disabled={busy || status === 'confirming'}>
              {status === 'confirming' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {approval.buttonLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
