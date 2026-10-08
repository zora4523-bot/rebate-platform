import { expect, it, vi } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import { FixedClock } from '../../clock/index.ts';
import { loadConfig } from '../../config/index.ts';
import {
  IdempotencyError,
  type Idempotency,
  type IdempotentResponse,
} from '../../idempotency/index.ts';
import { createRootLogger } from '../../logging/index.ts';
import type { TokenPrincipal } from '../token-context.ts';
import { AbandonController, type AbandonHttpRequest, type RawReply } from './abandon.controller.ts';

const PRINCIPAL: TokenPrincipal = {
  uid: '0192f0c4-7d1a-7c3e-8a00-000000000001',
  app_id: 'couli_alt',
  sid: '0192f0c4-7d1a-7c3e-8a00-000000000002',
  device_id: '0192f0c4-7d1a-7c3e-8a00-000000000003',
  scp: 'deletion_only',
};

function fakeIdempotency(abandon: Idempotency['abandon']): Idempotency {
  const refuse = () => Promise.reject(new Error('not used'));
  return { execute: refuse, executeInTransaction: refuse, purgeExpired: refuse, abandon };
}

function request(principal: TokenPrincipal | undefined): AbandonHttpRequest {
  return {
    id: 'trace-1',
    body: { action: 'account_deletion', idempotency_key: 'abandon-test-0001' },
    ...(principal === undefined ? {} : { principal }),
  };
}

function recordingReply() {
  const calls: { code?: number; type?: string; body?: string } = {};
  const reply: RawReply = {
    code(statusCode) {
      calls.code = statusCode;
      return reply;
    },
    type(contentType) {
      calls.type = contentType;
      return reply;
    },
    send(payload) {
      calls.body = payload;
      return reply;
    },
  };
  return { reply, calls };
}

it('[AC-B1-02g#13] passes the token principal, the body and the trace id; writes status and body bytes unchanged', async () => {
  const body = '{ "code":40901,  "msg":"x", "trace_id":"trace-1" }';
  const result: IdempotentResponse = { status: 409, body, source: 'idempotency' };
  const abandon = vi.fn<Idempotency['abandon']>().mockResolvedValue(result);
  const controller = new AbandonController(fakeIdempotency(abandon));
  const { reply, calls } = recordingReply();
  await controller.abandon(request(PRINCIPAL), reply);
  expect(abandon).toHaveBeenCalledExactlyOnceWith({
    appId: 'couli_alt',
    userId: PRINCIPAL.uid,
    action: 'account_deletion',
    key: 'abandon-test-0001',
    traceId: 'trace-1',
  });
  expect(calls).toEqual({ code: 409, type: 'application/json; charset=utf-8', body });
});

it('[AC-B1-02g#14] lets outcome_unknown reach the global error filter unchanged', async () => {
  const error = new IdempotencyError('outcome_unknown');
  const controller = new AbandonController(
    fakeIdempotency(vi.fn<Idempotency['abandon']>().mockRejectedValue(error)),
  );
  const { reply, calls } = recordingReply();
  await expect(controller.abandon(request(PRINCIPAL), reply)).rejects.toBe(error);
  expect(calls).toEqual({});
});

it('[AC-B1-02g#15] fails closed without a database or a principal and never calls the primitive', async () => {
  const { reply, calls } = recordingReply();
  await expect(new AbandonController(undefined).abandon(request(PRINCIPAL), reply)).rejects.toThrow(
    Error,
  );
  const abandon = vi.fn<Idempotency['abandon']>();
  await expect(
    new AbandonController(fakeIdempotency(abandon)).abandon(request(undefined), reply),
  ).rejects.toThrow(Error);
  expect(abandon).not.toHaveBeenCalled();
  expect(calls).toEqual({});
});

it.each([
  ['api', true],
  ['admin', false],
  ['stream', false],
] as const)('[AC-B1-02g#15] %s entry mounts the abandon route: %s', async (entry, mounted) => {
  const app = await createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-08T04:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
  });
  try {
    await app.init();
    const fastify = app.getHttpAdapter().getInstance();
    await fastify.ready();
    expect(fastify.hasRoute({ method: 'POST', url: '/v1/idempotency-keys/abandon' })).toBe(mounted);
  } finally {
    await app.close();
  }
});
