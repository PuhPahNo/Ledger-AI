import type { AssistantApprovalRequest, AssistantArtifact, AssistantToolEvent } from '@/types/domain';

export type ChatMessage =
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

export type ApprovalStatus = 'confirming' | 'done' | 'declined' | 'expired';

export interface StoredConversation {
  version: 1;
  messages: ChatMessage[];
  previousResponseId: string | null;
  /** Action results the model has not been told about yet; sent with the next message. */
  pendingActionResults: string[];
  approvalStatus: Record<string, ApprovalStatus>;
}

const STORAGE_KEY = 'ledger:assistant:conversation:v1';
const MAX_STORED_MESSAGES = 60;

export function emptyConversation(): StoredConversation {
  return { version: 1, messages: [], previousResponseId: null, pendingActionResults: [], approvalStatus: {} };
}

export function loadConversation(): StoredConversation {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyConversation();
    const parsed = JSON.parse(raw) as Partial<StoredConversation>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.messages)) return emptyConversation();
    return {
      version: 1,
      messages: parsed.messages,
      previousResponseId: typeof parsed.previousResponseId === 'string' ? parsed.previousResponseId : null,
      pendingActionResults: Array.isArray(parsed.pendingActionResults) ? parsed.pendingActionResults.filter((note) => typeof note === 'string') : [],
      // An in-flight confirmation cannot survive a reload; drop that transient state.
      approvalStatus: Object.fromEntries(
        Object.entries(parsed.approvalStatus ?? {}).filter(([, status]) => status !== 'confirming'),
      ) as Record<string, ApprovalStatus>,
    };
  } catch {
    return emptyConversation();
  }
}

export function saveConversation(conversation: StoredConversation): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...conversation,
      messages: conversation.messages.slice(-MAX_STORED_MESSAGES),
    }));
  } catch {
    // Storage full, disabled, or unavailable (private mode): the chat still works in memory.
  }
}

export function clearConversation(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}
