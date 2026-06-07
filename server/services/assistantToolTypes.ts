import type { FastifyRequest } from 'fastify';
import type { AuthedUser } from '../auth/session.js';
import type { AssistantApprovalRequest, AssistantArtifact } from './assistantSchemas.js';

export interface AssistantToolContext {
  user: AuthedUser;
  request?: FastifyRequest;
  expandedDataApproved?: boolean;
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
}
