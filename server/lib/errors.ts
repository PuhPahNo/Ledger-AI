import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFound(message = 'Not found'): never {
  throw new HttpError(404, message);
}

export function badRequest(message = 'Bad request', details?: unknown): never {
  throw new HttpError(400, message, details);
}

export function unauthorized(message = 'Unauthorized'): never {
  throw new HttpError(401, message);
}

export function forbidden(message = 'Forbidden'): never {
  throw new HttpError(403, message);
}

export function conflict(message = 'Conflict', details?: unknown): never {
  throw new HttpError(409, message, details);
}

export function serviceUnavailable(message = 'Service unavailable', details?: unknown): never {
  throw new HttpError(503, message, details);
}

export function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof HttpError) {
    void reply.status(error.statusCode).send({ error: error.message, details: error.details });
    return;
  }
  if (error instanceof ZodError) {
    void reply.status(400).send({ error: 'Invalid request', details: error.flatten() });
    return;
  }
  const message = error instanceof Error ? error.message : 'Unexpected error';
  void reply.status(500).send({ error: message });
}
