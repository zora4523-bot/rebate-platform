import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import { FixedClock, createRootLogger, loadConfig } from '../../../platform/index.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('GET /healthz', () => {
  const clock = new FixedClock('2026-10-01T04:00:00.000Z');
  let app: NestFastifyApplication;

  beforeEach(async () => {
    clock.set('2026-10-01T04:00:00.000Z');
    app = await createHttpApp('api', {
      config: loadConfig({ APP_ENV: 'test' }),
      clock,
      logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with exactly the contract envelope and echoes a well-formed trace id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-trace-id': 'trace-abc_123' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({
      code: 0,
      msg: '',
      data: { status: 'ok', entry: 'api', now: '2026-10-01T04:00:00.000Z' },
      trace_id: 'trace-abc_123',
    });
  });

  it('takes `now` from the injected clock', async () => {
    clock.advanceMs(86_400_000 + 1);
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.json<{ data: { now: string } }>().data.now).toBe('2026-10-02T04:00:00.001Z');
  });

  it('generates a UUID trace id when the header is missing', async () => {
    const first = await app.inject({ method: 'GET', url: '/healthz' });
    const second = await app.inject({ method: 'GET', url: '/healthz' });
    const firstId = first.json<{ trace_id: string }>().trace_id;
    expect(firstId).toMatch(UUID);
    expect(second.json<{ trace_id: string }>().trace_id).not.toBe(firstId);
  });

  it.each(['bad id', '<script>', 'x'.repeat(65)])(
    'replaces the malformed trace id %s with a UUID',
    async (header) => {
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-trace-id': header },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ trace_id: string }>().trace_id).toMatch(UUID);
    },
  );

  it('does not open a listening socket', () => {
    expect(app.getHttpServer().listening).toBe(false);
  });
});
