import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import type {
  HandlerResult,
  IdempotentRequest,
  IdempotentResponse,
  Idempotency,
} from '../../../platform/index.ts';
import type {
  InviteBindCommand,
  InviteBinder,
  InviteBindingResult,
} from '../../application/invite-binder.ts';
import { InviterController, type InviterHttpRequest } from './inviter.controller.ts';

const APP = 'couli';
const USER = '019a0000-0000-7000-8000-00000000000a';
const DEVICE = '019a0000-0000-7000-8000-0000000000d1';
const TRACE = 'trace-b1-11e';
const TRX = { isTransaction: true } as unknown as Transaction<DB>;

interface Sent {
  status?: number;
  headers: Record<string, string>;
  body?: string;
}

function reply(sent: Sent) {
  const raw = {
    code(status: number) {
      sent.status = status;
      return raw;
    },
    header(name: string, value: string) {
      sent.headers[name] = value;
      return raw;
    },
    type() {
      return raw;
    },
    send(payload: string) {
      sent.body = payload;
      return undefined;
    },
  };
  return raw;
}

/** Runs the handler like the transactional mode; `replay` answers without calling it. */
function idempotency(
  requests: IdempotentRequest[],
  replay?: IdempotentResponse,
): Pick<Idempotency, 'executeInTransaction'> {
  return {
    async executeInTransaction(request, handler) {
      requests.push(request);
      if (replay !== undefined) return replay;
      const result: HandlerResult = await handler(TRX);
      return { status: result.status, body: JSON.stringify(result.envelope), source: 'handler' };
    },
  };
}

function binder(result: InviteBindingResult, commands: InviteBindCommand[]): InviteBinder {
  return {
    bind(trx, command) {
      expect(trx).toBe(TRX);
      commands.push(command);
      return Promise.resolve(result);
    },
  };
}

function request(
  overrides: Partial<InviterHttpRequest> = {},
  omit: readonly ('principal' | 'verifiedDevice')[] = [],
): InviterHttpRequest {
  const full: InviterHttpRequest = {
    id: TRACE,
    headers: { 'idempotency-key': 'key-b1-11e' },
    body: { invite_code: ' k7q2mz ' },
    principal: { uid: USER, app_id: APP, sid: 's', device_id: DEVICE, scp: 'full' },
    verifiedDevice: { deviceId: DEVICE, appId: APP },
    ...overrides,
  };
  const copy: Record<string, unknown> = { ...full };
  for (const key of omit) delete copy[key];
  return copy as unknown as InviterHttpRequest;
}

it('[AC-B1-11e#1] bound → 200 EmptyResponse; identity from token and signature, raw code', async () => {
  const commands: InviteBindCommand[] = [];
  const requests: IdempotentRequest[] = [];
  const sent: Sent = { headers: {} };
  const controller = new InviterController(
    binder({ result: 'bound', parent_id: 'p', bound_at: new Date(0) }, commands),
    idempotency(requests) as Idempotency,
  );
  await controller.bindInviter(request(), reply(sent));
  expect(sent.status).toBe(200);
  expect(JSON.parse(sent.body!)).toEqual({ code: 0, msg: '', data: {}, trace_id: TRACE });
  expect(sent.headers).toEqual({});
  expect(commands).toEqual([
    { channel: 'backfill', app_id: APP, user_id: USER, device_id: DEVICE, invite_code: ' k7q2mz ' },
  ]);
  expect(requests).toEqual([
    {
      appId: APP,
      actor: { userId: USER, deviceId: DEVICE, phoneHmac: null },
      method: 'POST',
      path: '/v1/me/inviter',
      key: 'key-b1-11e',
      body: { invite_code: ' k7q2mz ' },
      traceId: TRACE,
    },
  ]);
});

it('[AC-B1-11e#2] each failure code keeps its code, contract status and no data', async () => {
  const statuses = {
    10005: 403,
    30401: 422,
    30402: 422,
    30403: 422,
    30404: 422,
    30408: 422,
    30409: 422,
    50001: 500,
  } as const;
  for (const [text, status] of Object.entries(statuses)) {
    const code = Number(text) as keyof typeof statuses;
    const sent: Sent = { headers: {} };
    const controller = new InviterController(
      binder({ result: 'failed', code }, []),
      idempotency([]) as Idempotency,
    );
    await controller.bindInviter(request(), reply(sent));
    expect(sent.status).toBe(status);
    const body = JSON.parse(sent.body!) as Record<string, unknown>;
    expect(body).toEqual({ code, msg: expect.any(String), trace_id: TRACE });
    expect(sent.headers).toEqual({});
  }
});

it('[AC-B1-11e#2] 42901 answers 429 with the core seconds as Retry-After (at least 1)', async () => {
  for (const [seconds, header] of [
    [1234, '1234'],
    [0.2, '1'],
    [0, '1'],
  ] as const) {
    const sent: Sent = { headers: {} };
    const controller = new InviterController(
      binder({ result: 'failed', code: 42901, retry_after_seconds: seconds }, []),
      idempotency([]) as Idempotency,
    );
    await controller.bindInviter(request(), reply(sent));
    expect(sent.status).toBe(429);
    expect(sent.headers).toEqual({ 'Retry-After': header });
    expect(JSON.parse(sent.body!)).toMatchObject({ code: 42901 });
  }
});

it('[AC-B1-11e#2] 42901 without seconds is a programming error, never a 429 without Retry-After', async () => {
  const controller = new InviterController(
    binder({ result: 'failed', code: 42901 }, []),
    idempotency([]) as Idempotency,
  );
  await expect(controller.bindInviter(request(), reply({ headers: {} }))).rejects.toThrow(
    'growth: 42901 without retry_after_seconds',
  );
});

it('[AC-B1-11e#5] a replayed response is written as stored, without calling the core or Retry-After', async () => {
  const commands: InviteBindCommand[] = [];
  const sent: Sent = { headers: {} };
  const stored = '{"code":30401,"msg":"邀请码无效","trace_id":"first"}';
  const controller = new InviterController(
    binder({ result: 'failed', code: 42901, retry_after_seconds: 9 }, commands),
    idempotency([], { status: 422, body: stored, source: 'replay' }) as Idempotency,
  );
  await controller.bindInviter(request(), reply(sent));
  expect(commands).toEqual([]);
  expect(sent).toEqual({ status: 422, headers: {}, body: stored });
});

it('[AC-B1-11e#9] fails closed without the core, a token, a signature device or matching apps', async () => {
  const commands: InviteBindCommand[] = [];
  const core = binder({ result: 'bound', parent_id: 'p', bound_at: new Date(0) }, commands);
  const cases: [InviteBinder | null, Idempotency | undefined, InviterHttpRequest][] = [
    [null, idempotency([]) as Idempotency, request()],
    [core, undefined, request()],
    [core, idempotency([]) as Idempotency, request({}, ['principal'])],
    [core, idempotency([]) as Idempotency, request({}, ['verifiedDevice'])],
    [
      core,
      idempotency([]) as Idempotency,
      request({ verifiedDevice: { deviceId: DEVICE, appId: 'other' } }),
    ],
  ];
  for (const [binderPort, idem, input] of cases) {
    const controller = new InviterController(binderPort, idem);
    await expect(controller.bindInviter(input, reply({ headers: {} }))).rejects.toThrow(/growth:/);
  }
  expect(commands).toEqual([]);
});
