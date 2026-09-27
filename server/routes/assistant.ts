import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { HttpError } from '../lib/errors.js';
import { runAssistantMessage, type AssistantStreamEvent } from '../services/assistantAgent.js';
import { assistantApiResponseSchema } from '../services/assistantSchemas.js';
import { confirmAssistantAction } from '../services/assistantTools.js';

const GENERIC_FAILURE = 'The assistant hit an error while answering. Please try again.';

const messageSchema = z.object({
  message: z.string().max(4000).optional().default(''),
  previousResponseId: z.string().nullable().optional(),
  approvedDataToken: z.string().nullable().optional(),
  actionResults: z.array(z.string().max(1000)).max(10).optional().default([]),
  stream: z.boolean().optional().default(false),
}).refine((body) => body.message.trim().length > 0 || Boolean(body.approvedDataToken), {
  message: 'A message or an approval token is required.',
  path: ['message'],
});

function logFailure(request: FastifyRequest, error: unknown, what: string) {
  request.log.error({ err: error }, what);
}

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.post('/assistant/message', async (request, reply) => {
    const user = await requireUser(request);
    const body = messageSchema.parse(request.body);
    const runInput = {
      message: body.message,
      previousResponseId: body.previousResponseId,
      approvedDataToken: body.approvedDataToken,
      actionResults: body.actionResults,
      context: { user, request },
    };

    if (!body.stream) {
      try {
        return await runAssistantMessage(runInput);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        logFailure(request, error, 'assistant message failed');
        throw new HttpError(502, GENERIC_FAILURE);
      }
    }

    // Take over the response for NDJSON streaming. Headers already set by hooks (CORS,
    // rate limit, etc.) are carried over explicitly because onSend hooks will not run.
    reply.hijack();
    const headers: Record<string, string | number | string[]> = {};
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) headers[name] = value;
    }
    reply.raw.writeHead(200, {
      ...headers,
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    reply.raw.on('close', () => {
      closed = true;
    });
    const send = (event: AssistantStreamEvent) => {
      if (closed || reply.raw.writableEnded) return;
      reply.raw.write(`${JSON.stringify(event)}\n`);
    };
    try {
      await runAssistantMessage({ ...runInput, onEvent: send });
    } catch (error) {
      logFailure(request, error, 'assistant stream failed');
      send({
        type: 'final',
        response: assistantApiResponseSchema.parse({
          answer: error instanceof HttpError ? error.message : GENERIC_FAILURE,
          artifacts: [],
          approvalRequests: [],
          followUpSuggestions: [],
          toolEvents: [],
          // Keep the conversation thread intact so the user can simply retry.
          nextResponseId: body.previousResponseId ?? null,
        }),
      });
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
    return reply;
  });

  app.post('/assistant/actions/confirm', async (request) => {
    const user = await requireUser(request);
    const body = z.object({ token: z.string().min(1) }).parse(request.body);
    try {
      return await confirmAssistantAction(body.token, { user, request });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      logFailure(request, error, 'assistant action confirmation failed');
      throw new HttpError(500, 'The action could not be applied. Please try again.');
    }
  });
}
