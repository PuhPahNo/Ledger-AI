import type { FastifyRequest } from 'fastify';
import type { AuthedUser } from '../auth/session.js';
import type { AssistantApprovalRequest, AssistantArtifact } from './assistantSchemas.js';

export interface AssistantToolContext {
  user: AuthedUser;
  request?: FastifyRequest;
  expandedDataApproved?: boolean;
  /** The user question driving this turn; bound into expanded-data approvals. */
  question?: string;
}

export interface AssistantToolResult {
  ok: boolean;
  message: string;
  data?: unknown;
  artifacts?: AssistantArtifact[];
  approvalRequests?: AssistantApprovalRequest[];
}

export interface ConfirmAssistantActionResult {
  ok: boolean;
  message: string;
  artifact?: AssistantArtifact;
  /** jti of the consumed approval token. */
  actionId?: string;
  /** Plain-text summary the client feeds back to the model on its next turn. */
  contextNote?: string;
}
