import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { runAssistantMessage, type AssistantStreamEvent } from '../services/assistantAgent.js';
import { assistantApiResponseSchema } from '../services/assistantSchemas.js';
import { confirmAssistantAction } from '../services/assistantTools.js';

const messageSchema = z.object({
  message: z.string().min(1).max(4000),
  previousResponseId: z.string().nullable().optional(),
  approvedDataToken: z.string().nullable().optional(),
  stream: z.boolean().optional().default(false),
});

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.post('/assistant/message', async (request, reply) => {
    const user = await requireUser(request);
    const body = messageSchema.parse(request.body);
    if (!body.stream) {
      return runAssistantMessage({
        message: body.message,
        previousResponseId: body.previousResponseId,
        approvedDataToken: body.approvedDataToken,
        context: { user, request },
      });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const send = (event: AssistantStreamEvent) => {
      reply.raw.write(`${JSON.stringify(event)}\n`);
    };
    try {
      await runAssistantMessage({
        message: body.message,
        previousResponseId: body.previousResponseId,
        approvedDataToken: body.approvedDataToken,
        context: { user, request },
        onEvent: send,
      });
    } catch (error) {
      send({
        type: 'final',
        response: assistantApiResponseSchema.parse({
          answer: error instanceof Error ? error.message : 'Assistant request failed.',
          artifacts: [],
          approvalRequests: [],
          followUpSuggestions: [],
          toolEvents: [],
          nextResponseId: body.previousResponseId ?? null,
        }),
      });
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  app.post('/assistant/actions/confirm', async (request) => {
    const user = await requireUser(request);
    const body = z.object({ token: z.string().min(1) }).parse(request.body);
    return confirmAssistantAction(body.token, { user, request });
  });
}
