import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../auth/session.js', () => ({
  requireUser: async () => ({ id: 'user-1', username: 'admin', displayName: 'Admin', role: 'admin', totpEnabled: false }),
}));

const runAssistantMessage = vi.fn();
vi.mock('../services/assistantAgent.js', () => ({
  runAssistantMessage: (...args: unknown[]) => runAssistantMessage(...args),
}));

const { assistantRoutes } = await import('./assistant.js');

async function buildApp() {
  const app = Fastify();
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('access-control-allow-origin', 'http://localhost:5173');
  });
  await assistantRoutes(app);
  return app;
}

describe('assistant streaming route', () => {
  it('streams NDJSON with hook headers preserved', async () => {
    runAssistantMessage.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'status', message: 'working' });
      onEvent({ type: 'final', response: { answer: 'done' } });
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/assistant/message', payload: { message: 'hi', stream: true } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const lines = res.body.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(['status', 'final']);
  });

  it('sends a generic error to the client instead of the raw message', async () => {
    runAssistantMessage.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/assistant/message', payload: { message: 'hi', stream: true, previousResponseId: 'resp_1' } });
    const final = JSON.parse(res.body.trim().split('\n').at(-1)!);
    expect(final.type).toBe('final');
    expect(final.response.answer).not.toContain('ECONNREFUSED');
    expect(final.response.answer).toMatch(/try again/i);
    expect(final.response.nextResponseId).toBe('resp_1');
  });

  it('allows an approval token without a message, but not an empty request', async () => {
    runAssistantMessage.mockResolvedValueOnce({ answer: 'ok' });
    const app = await buildApp();
    const ok = await app.inject({ method: 'POST', url: '/assistant/message', payload: { approvedDataToken: 'tok' } });
    expect(ok.statusCode).toBe(200);
    expect(runAssistantMessage.mock.lastCall?.[0]).toMatchObject({ message: '', approvedDataToken: 'tok' });
    const bad = await app.inject({ method: 'POST', url: '/assistant/message', payload: { message: '   ' } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
  });
});
