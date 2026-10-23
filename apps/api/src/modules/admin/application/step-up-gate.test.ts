// Unit tests of the step-up gate of the super admin's account writes (B1-34h) over a minimal
// in-memory Redis double that applies the claim script by its effect.
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { FixedClock, type RedisNamespace, type RedisScriptOptions } from '../../platform/index.ts';
import type { AdminRevocations } from '../infra/admin-revocations.ts';
import { createAdminStepUpGate, createAdminStepUpTokens } from './permission-guard.ts';

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

function setup(voidedAt: () => number | null) {
  const clock = new FixedClock('2026-10-09T02:00:00.000Z');
  const redis = memoryRedis();
  const revocations: AdminRevocations = {
    voidBefore: async () => undefined,
    voidedAt: async () => voidedAt(),
  };
  const principal = { appId: 'couli', adminId: randomUUID(), sessionId: randomUUID() };
  return {
    clock,
    principal,
    tokens: createAdminStepUpTokens({ clock, redis }),
    gate: createAdminStepUpGate({ clock, redis, revocations }),
  };
}

const SUCCESS = { statusCode: 200, body: { code: 0 } };

it('[AC-B1-34h] the gate needs a totp token of the caller and consumes it on success only', async () => {
  const s = setup(() => null);
  const business = vi.fn(async () => SUCCESS);
  const run = (token?: string) =>
    s.gate.run(
      {
        principal: s.principal,
        tier: 'totp',
        headers: token === undefined ? {} : { 'x-step-up-token': token },
        traceId: 't',
      },
      business,
    );
  await expect(run()).rejects.toBeInstanceOf(HttpException);
  const sms = await s.tokens.issue({ ...s.principal, tier: 'sms' });
  await expect(run(sms.step_up_token)).rejects.toBeInstanceOf(HttpException);
  const grant = await s.tokens.issue({ ...s.principal, tier: 'totp' });
  await expect(run(grant.step_up_token)).resolves.toBe(SUCCESS);
  await expect(run(grant.step_up_token)).rejects.toBeInstanceOf(HttpException);
  expect(business).toHaveBeenCalledTimes(1);
});

it('[AC-B1-34h] a step-up token issued before the account voided its credentials is refused', async () => {
  let voided: number | null = null;
  const s = setup(() => voided);
  const grant = await s.tokens.issue({ ...s.principal, tier: 'totp' });
  voided = s.clock.now().getTime() + 1;
  const business = vi.fn(async () => SUCCESS);
  const error = await s.gate
    .run(
      {
        principal: s.principal,
        tier: 'totp',
        headers: { 'x-step-up-token': grant.step_up_token },
        traceId: 't',
      },
      business,
    )
    .catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getResponse()).toMatchObject({
    code: 10003,
    data: { tier: 'totp' },
  });
  expect(business).not.toHaveBeenCalled();
});
