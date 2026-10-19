import { HttpException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  contractRouteSchema,
  createRootLogger,
  loadConfig,
} from '../../../platform/index.ts';
import type {
  LandingRegisterAnswer,
  LandingRegisterCommand,
  LandingRegisterService,
} from '../../application/landing-register.ts';
import {
  LandingRegisterController,
  type LandingRegisterHttpRequest,
  type LandingRegisterRawReply,
} from './landing-register.controller.ts';

const TRACE = 'abcdefABCDEF01234567abcdefABCDEF';

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Sent {
  status?: number;
  headers: [string, string][];
  body?: string;
}

function controller(answer: LandingRegisterAnswer | null) {
  const register = vi.fn(async (command: LandingRegisterCommand) => {
    void command;
    return answer!;
  });
  const service = answer === null ? null : ({ register } as unknown as LandingRegisterService);
  const sent: Sent = { headers: [] };
  const reply: LandingRegisterRawReply = {
    code(status) {
      sent.status = status;
      return reply;
    },
    header(name, value) {
      sent.headers.push([name, value]);
      return reply;
    },
    type() {
      return reply;
    },
    send(payload) {
      sent.body = payload;
      return undefined;
    },
  };
  const request: LandingRegisterHttpRequest = {
    id: TRACE,
    ip: '203.0.113.7',
    headers: { 'x-app-id': 'couli', 'x-channel': 'appstore', 'idempotency-key': 'key-0001' },
    body: { phone: '13912345678', sms_code: '1', invite_code: 'K7Q2MZ', agreed: true },
  };
  return { target: new LandingRegisterController(service), register, sent, reply, request };
}

it('[AC-B1-11h#1] the controller passes X-App-Id, X-Channel, the key and the IP, writes the answer', async () => {
  const c = controller({ kind: 'response', status: 429, body: '{"code":42901}', retryAfter: 7 });
  await c.target.landingRegister(c.request, c.reply);
  expect(c.register).toHaveBeenCalledExactlyOnceWith({
    app_id: 'couli',
    body: c.request.body,
    header_channel: 'appstore',
    client_ip: '203.0.113.7',
    idempotency_key: 'key-0001',
    trace_id: TRACE,
  });
  expect(c.sent).toEqual({
    status: 429,
    headers: [['Retry-After', '7']],
    body: '{"code":42901}',
  });
});

it('[AC-B1-11h#5] an answer before idempotency is thrown as the HttpException envelope', async () => {
  const envelope = { code: 10004, msg: 'm', data: { consent_type: 'agreement' }, trace_id: TRACE };
  const c = controller({ kind: 'refused', status: 403, envelope });
  const error = await c.target
    .landingRegister(c.request, c.reply)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(403);
  expect((error as HttpException).getResponse()).toEqual(envelope);
  expect(c.sent).toEqual({ headers: [] });
});

it('[AC-B1-11h#1] without the service the landing registration fails closed', async () => {
  const c = controller(null);
  await expect(c.target.landingRegister(c.request, c.reply)).rejects.toThrow(
    /landing registration needs/,
  );
});

it('[AC-B1-11h#1] the api entry mounts the landingRegister contract route schema', async () => {
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-18T02:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  const schemas: unknown[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url === '/v1/invites/landing-register')
        schemas.push({ method: route.method, schema: route.schema });
    });
  await app.init();
  expect(schemas).toEqual([{ method: 'POST', schema: contractRouteSchema('landingRegister') }]);
});
