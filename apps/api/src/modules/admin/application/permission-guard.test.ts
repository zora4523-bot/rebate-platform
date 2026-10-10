// Unit tests of the step-up tokens and the permission guard over an in-memory Redis double that
// applies the guard's scripts by their effect; the scripts themselves run against Redis in the
// rule tests (test/spec/admin/permissions/**).
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { FixedClock, type RedisNamespace, type RedisScriptOptions } from '../../platform/index.ts';
import {
  createAdminPermissionGuard,
  createAdminStepUpTokens,
  type AdminBusinessResponse,
  type AdminPermissionPrincipal,
} from './permission-guard.ts';

function memoryRedis(): RedisNamespace {
  const data = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(data.get(key) ?? null),
    set: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    eval: (script: string, options: RedisScriptOptions) => {
      const [first, second] = options.keys;
      if (script.includes("'NX'")) {
        if (!data.has(first!) || data.has(second!)) return Promise.resolve(0);
        data.set(second!, '1');
        return Promise.resolve(1);
      }
      data.delete(first!);
      return Promise.resolve(1);
    },
  };
}

const SUCCESS: AdminBusinessResponse = { statusCode: 200, body: { code: 0 } };

function setup() {
  const clock = new FixedClock('2026-10-09T02:00:00.000Z');
  const redis = memoryRedis();
  const tokens = createAdminStepUpTokens({ clock, redis });
  const guard = createAdminPermissionGuard({ clock, redis });
  const principal: AdminPermissionPrincipal = {
    appId: 'couli',
    adminId: randomUUID(),
    sessionId: randomUUID(),
    isSuper: false,
    permissions: ['fund.adjust', 'pii.reveal_phone', 'user.list'],
    hasVerifyPhone: true,
  };
  return { clock, tokens, guard, principal };
}

async function rejection(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  return { status: http.getStatus(), body: http.getResponse() };
}

it('[AC-F1-06l#14] tokens are opaque, random and expire five minutes after issue by the Clock', async () => {
  const s = setup();
  const grant = await s.tokens.issue({ ...s.principal, tier: 'totp' });
  expect(grant.tier).toBe('totp');
  expect(grant.expire_at).toBe('2026-10-09T02:05:00.000Z');
  expect(grant.step_up_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await s.tokens.issue({ ...s.principal, tier: 'totp' })).step_up_token).not.toBe(
    grant.step_up_token,
  );
});

it('[AC-F1-06l#21] a point that is not ticked is 10403 with a trace id', async () => {
  const s = setup();
  const business = vi.fn(async () => SUCCESS);
  const result = await rejection(
    s.guard.run(
      { principal: s.principal, permission: 'fund.writeoff', headers: {}, traceId: 't-1' },
      business,
    ),
  );
  expect(result).toEqual({
    status: 403,
    body: expect.objectContaining({
      code: 10403,
      data: { reason: 'admin_permission_denied' },
      trace_id: 't-1',
    }),
  });
  expect(business).not.toHaveBeenCalled();
});

it('[AC-F1-06l#24] an sms point on an account without verify phone names the reason', async () => {
  const s = setup();
  const result = await rejection(
    s.guard.run(
      {
        principal: { ...s.principal, hasVerifyPhone: false },
        permission: 'fund.adjust',
        headers: {},
      },
      async () => SUCCESS,
    ),
  );
  expect(result.body).toMatchObject({
    code: 10003,
    data: { tier: 'sms', reason: 'verify_phone_missing' },
  });
});

it('[AC-F1-06l#26] [AC-F1-06l#27] success consumes the token; a failed answer keeps it', async () => {
  const s = setup();
  const grant = await s.tokens.issue({ ...s.principal, tier: 'sms' });
  const request = {
    principal: s.principal,
    permission: 'fund.adjust',
    headers: { 'x-step-up-token': grant.step_up_token },
  };
  const failed = { statusCode: 200, body: { code: 20001 } };
  expect(await s.guard.run(request, async () => failed)).toEqual(failed);
  await expect(
    s.guard.run(request, async () => {
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  expect(await s.guard.run(request, async () => SUCCESS)).toEqual(SUCCESS);
  const replay = await rejection(s.guard.run(request, async () => SUCCESS));
  expect(replay.body).toMatchObject({ code: 10003, data: { tier: 'sms' } });
});

it('[AC-F1-06l#25] a token of another tier, session or an expired one is refused', async () => {
  const s = setup();
  const totp = await s.tokens.issue({ ...s.principal, tier: 'totp' });
  const sms = await s.tokens.issue({ ...s.principal, tier: 'sms' });
  const run = (permission: string, token: string, principal = s.principal) =>
    rejection(
      s.guard.run(
        { principal, permission, headers: { 'x-step-up-token': token } },
        async () => SUCCESS,
      ),
    );
  expect((await run('fund.adjust', totp.step_up_token)).body).toMatchObject({
    code: 10003,
    data: { tier: 'sms' },
  });
  expect(
    (await run('fund.adjust', sms.step_up_token, { ...s.principal, sessionId: randomUUID() })).body,
  ).toMatchObject({ code: 10003 });
  s.clock.advanceMs(300_000);
  expect((await run('fund.adjust', sms.step_up_token)).body).toMatchObject({ code: 10003 });
});

it('[AC-F1-06l#28] an operation without step-up runs and leaves the token alone', async () => {
  const s = setup();
  const grant = await s.tokens.issue({ ...s.principal, tier: 'totp' });
  const headers = { 'x-step-up-token': grant.step_up_token };
  expect(
    await s.guard.run(
      { principal: s.principal, permission: 'user.list', headers },
      async () => SUCCESS,
    ),
  ).toEqual(SUCCESS);
  expect(
    await s.guard.run(
      { principal: s.principal, permission: 'pii.reveal_phone', headers },
      async () => SUCCESS,
    ),
  ).toEqual(SUCCESS);
});
