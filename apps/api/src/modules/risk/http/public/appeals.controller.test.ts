// Unit tests of AppealsController.submit's answer mapping (CT-26e): the service result → the HTTP
// status and envelope handed to platform idempotency. Idempotency and the service are fakes; the
// real route runs in the rule tests (test/spec/risk/appeals).
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { HandlerResult, Idempotency } from '../../../platform/index.ts';
import type { AppealsService, SubmitAppealResult } from '../../application/appeals.ts';
import {
  AppealsController,
  type AppealsHttpRequest,
  type AppealsRawReply,
} from './appeals.controller.ts';

const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

async function submitWith(outcome: SubmitAppealResult) {
  const handled: HandlerResult[] = [];
  const idempotency = {
    executeInTransaction: vi.fn(
      async (_request: unknown, handler: (trx: Transaction<DB>) => Promise<HandlerResult>) => {
        const result = await handler({} as Transaction<DB>);
        handled.push(result);
        return { status: result.status, body: JSON.stringify(result.envelope), source: 'handler' };
      },
    ),
  } as unknown as Idempotency;
  const submit = vi.fn(async () => outcome);
  const appeals = { submit, list: vi.fn() } as unknown as AppealsService;
  const sent: { status?: number; body?: string } = {};
  const reply: AppealsRawReply = {
    code(status) {
      sent.status = status;
      return reply;
    },
    type: () => reply,
    send(payload) {
      sent.body = payload;
      return undefined;
    },
  };
  const request = {
    id: TRACE,
    headers: { 'idempotency-key': 'k-1' },
    body: { target_type: 'account', content: '请复核' },
    principal: { uid: 'u-1', app_id: 'couli', sid: 's', device_id: 'd', scp: 'full' },
  } as unknown as AppealsHttpRequest;
  await new AppealsController(appeals, idempotency).submit(request, reply);
  return { handled, sent, submit };
}

it('[AC-CT-26e-UNIT#13] 30418 from the service → HTTP 422, code 30418, no data, handed to idempotency to store', async () => {
  const { handled, sent, submit } = await submitWith({ code: 30418 });
  expect(submit).toHaveBeenCalledWith(
    {},
    { app_id: 'couli', user_id: 'u-1' },
    { target_type: 'account', content: '请复核' },
  );
  expect(handled).toEqual([
    {
      status: 422,
      envelope: { code: 30418, msg: '这项申诉的次数已用完，不能再提交申诉', trace_id: TRACE },
    },
  ]);
  expect(sent.status).toBe(422);
  expect(JSON.parse(sent.body!)).not.toHaveProperty('data');
});

it('[AC-CT-26e-UNIT#14] 20001 from the service stays a 20001 refusal, never 30418', async () => {
  const { handled, sent } = await submitWith({ code: 20001 });
  expect(handled[0]!.envelope.code).toBe(20001);
  expect(sent.status).toBe(handled[0]!.status);
  expect(sent.status).not.toBe(422);
});
