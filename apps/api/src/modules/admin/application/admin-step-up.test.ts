// Unit tests of the step-up use cases over doubles of the stores, the sender and the verifier;
// the SQL and Redis scripts run against real services in the rule tests (test/spec/admin/**).
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { STEP_UP_SMS_HISTORY_KEEP, STEP_UP_SMS_HISTORY_MS } from '../domain/step-up-policy.ts';
import type { AdminAccount, AdminAccounts } from '../infra/admin-accounts.ts';
import type { AdminProfile, AdminProfiles } from '../infra/admin-profiles.ts';
import type { CodeCheck, StepUpSmsCodes } from '../infra/step-up-sms-codes.ts';
import { NO_SMS_SENDER, createAdminStepUpService, type AdminSmsSender } from './admin-step-up.ts';
import type { AdminStepUpTokens } from './permission-guard.ts';

interface MemoryCodes extends StepUpSmsCodes {
  readonly state: {
    current: { hash: string; exp: number } | undefined;
    history: { hash: string; at: number }[];
    failStore: boolean;
  };
}

/** StepUpSmsCodes double with the semantics of infra/step-up-sms-codes.ts. */
function memoryCodes(): MemoryCodes {
  let sent: { at: number; reservation: string } | undefined;
  const state: MemoryCodes['state'] = { current: undefined, history: [], failStore: false };
  const windowed = (nowMs: number): { hash: string; at: number }[] =>
    state.history
      .filter((v) => nowMs - v.at < STEP_UP_SMS_HISTORY_MS)
      .slice(-STEP_UP_SMS_HISTORY_KEEP);
  return {
    state,
    knownHashes: () =>
      Promise.resolve(
        new Set([
          ...(state.current ? [state.current.hash] : []),
          ...state.history.map((v) => v.hash),
        ]),
      ),
    reserve: (_app, _admin, nowMs, intervalMs) => {
      if (sent !== undefined && nowMs - sent.at < intervalMs) {
        return Promise.resolve({ kind: 'limited', retryAfterMs: sent.at + intervalMs - nowMs });
      }
      sent = { at: nowMs, reservation: randomUUID() };
      return Promise.resolve({ kind: 'reserved', reservation: sent.reservation });
    },
    release: (_app, _admin, reservation) => {
      if (sent?.reservation === reservation) sent = undefined;
      return Promise.resolve();
    },
    store: (_app, _admin, hash, nowMs, exp) => {
      if (state.failStore) return Promise.reject(new Error('redis down'));
      state.history = [...windowed(nowMs), { hash, at: nowMs }].slice(-STEP_UP_SMS_HISTORY_KEEP);
      state.current = { hash, exp };
      return Promise.resolve();
    },
    revoke: (_app, _admin, hash, nowMs) => {
      if (state.current?.hash === hash) state.current = undefined;
      state.history = windowed(nowMs).filter((v) => v.hash !== hash);
      return Promise.resolve();
    },
    check: (_app, _admin, hash, nowMs): Promise<CodeCheck> => {
      const live = state.current !== undefined && state.current.exp > nowMs;
      if (live && state.current!.hash === hash) {
        state.current = undefined;
        return Promise.resolve('ok');
      }
      if (windowed(nowMs).some((v) => v.hash === hash)) return Promise.resolve('voided');
      if (state.current?.hash === hash) return Promise.resolve('expired');
      return Promise.resolve(live ? 'wrong' : 'none');
    },
  };
}

function setup(
  options: {
    phone?: boolean;
    isSuper?: boolean;
    ticked?: string[];
    sender?: AdminSmsSender;
  } = {},
) {
  const clock = new FixedClock('2026-10-09T02:00:00.000Z');
  const id = randomUUID();
  const account: AdminAccount = {
    id,
    appId: 'couli',
    loginName: 'finance-jia',
    passwordHash: 'x',
    totpSecretCipher: Buffer.from('secret'),
    totpBoundAt: clock.now(),
    isSuper: options.isSuper ?? false,
    status: 'active',
    passwordMustChange: false,
    failedLoginCount: 0,
    lockedUntil: null,
  };
  const profile: AdminProfile = {
    id,
    appId: 'couli',
    loginName: account.loginName,
    isSuper: account.isSuper,
    status: 'active',
    verifyPhoneCipher: options.phone === false ? null : Buffer.from('cipher:13800135678'),
  };
  const failures = vi.fn();
  const accounts = {
    byId: () => Promise.resolve(account),
    recordFailure: (...args: unknown[]) => {
      failures(...args);
      return Promise.resolve({ kind: 'counted', count: failures.mock.calls.length });
    },
  } as unknown as AdminAccounts;
  const profiles: AdminProfiles = {
    byId: () => Promise.resolve(profile),
    permissionKeys: () => Promise.resolve(options.ticked ?? []),
  };
  const outbox: { phone: string; code: string; purpose: string }[] = [];
  const results: ('accepted' | 'rejected' | 'unknown')[] = [];
  const codes = memoryCodes();
  const blindIndex = (value: string, context: string): string => `h(${context}|${value})`;
  /** What the code record held when each SMS went out (the record comes first). */
  const atSend: { current: string | undefined; history: string[] }[] = [];
  const sender: AdminSmsSender = options.sender ?? {
    send: (message) => {
      atSend.push({
        current: codes.state.current?.hash,
        history: codes.state.history.map((v) => v.hash),
      });
      const result = results.shift() ?? 'accepted';
      if (result !== 'rejected') outbox.push(message);
      return Promise.resolve(result);
    },
  };
  const totpCodes = new Set(['totp-ok']);
  const tokens: AdminStepUpTokens = {
    issue: (binding) =>
      Promise.resolve({ step_up_token: `t-${binding.tier}`, tier: binding.tier, expire_at: 'e' }),
  };
  const service = createAdminStepUpService({
    clock,
    accounts,
    profiles,
    totp: { verify: ({ code }) => Promise.resolve(totpCodes.has(code)) },
    smsCodes: codes,
    sender,
    tokens,
    crypto: {
      decrypt: (cipher) => cipher.replace(/^cipher:/, ''),
      blindIndex,
    },
  });
  const caller = { appId: 'couli', adminId: id, sessionId: randomUUID(), ip: '127.0.0.1' };
  const hashOf = (code: string): string =>
    blindIndex(code, `admin_step_up.sms_code:${caller.appId}:${caller.adminId}`);
  return { clock, service, caller, outbox, results, failures, codes, atSend, hashOf };
}

it('[AC-F1-06l#7] [AC-F1-06l#8] sends six digits to the verify phone, then limits for 60 seconds', async () => {
  const s = setup();
  expect(await s.service.sendSms(s.caller)).toEqual({
    code: 0,
    resendAfterSec: 60,
    expiresInSec: 300,
  });
  expect(s.outbox).toEqual([
    {
      app_id: 'couli',
      phone: '13800135678',
      purpose: 'step_up',
      code: expect.stringMatching(/^\d{6}$/),
    },
  ]);
  s.clock.advanceMs(59_001);
  expect(await s.service.sendSms(s.caller)).toEqual({ code: 42901, retryAfterSec: 1 });
  s.clock.advanceMs(999);
  expect((await s.service.sendSms(s.caller)).code).toBe(0);
});

it('[AC-F1-06l#6] no verify phone: 10003 for send and sms step-up, nothing sent', async () => {
  const s = setup({ phone: false });
  expect(await s.service.sendSms(s.caller)).toEqual({ code: 10003 });
  expect(await s.service.stepUp(s.caller, 'sms', '123456')).toEqual({ code: 10003 });
  expect(s.outbox).toEqual([]);
});

it('[AC-F1-06l#9] a rejected send frees the slot; an unknown outcome counts as sent', async () => {
  const s = setup();
  s.results.push('rejected', 'unknown');
  expect(await s.service.sendSms(s.caller)).toEqual({ code: 50001 });
  expect((await s.service.sendSms(s.caller)).code).toBe(0);
  expect((await s.service.sendSms(s.caller)).code).toBe(42901);
  const code = s.outbox.at(-1)!.code;
  expect(await s.service.stepUp(s.caller, 'sms', code)).toMatchObject({ code: 0 });
});

it('[AC-F1-06l#33] each tier accepts only its own code; a cross-tier code is a counted 20002', async () => {
  const s = setup();
  expect((await s.service.sendSms(s.caller)).code).toBe(0);
  const sms = s.outbox.at(-1)!.code;
  expect(await s.service.stepUp(s.caller, 'sms', 'totp-ok')).toEqual({ code: 20002 });
  expect(await s.service.stepUp(s.caller, 'totp', sms)).toEqual({ code: 20002 });
  expect(s.failures).toHaveBeenCalledTimes(2);
  expect(await s.service.stepUp(s.caller, 'totp', 'totp-ok')).toMatchObject({
    code: 0,
    grant: { tier: 'totp' },
  });
  expect(await s.service.stepUp(s.caller, 'sms', sms)).toMatchObject({
    code: 0,
    grant: { tier: 'sms' },
  });
});

it('[AC-F1-06l#10] [AC-F1-06l#12] no pending code, a used or replaced code is 20003 and not counted', async () => {
  const s = setup();
  expect(await s.service.stepUp(s.caller, 'sms', 'totp-ok')).toEqual({ code: 20003 });
  await s.service.sendSms(s.caller);
  const old = s.outbox.at(-1)!.code;
  s.clock.advanceMs(60_000);
  await s.service.sendSms(s.caller);
  const current = s.outbox.at(-1)!.code;
  expect(current).not.toBe(old);
  expect(await s.service.stepUp(s.caller, 'sms', old)).toEqual({ code: 20003 });
  expect((await s.service.stepUp(s.caller, 'sms', current)).code).toBe(0);
  expect(await s.service.stepUp(s.caller, 'sms', current)).toEqual({ code: 20003 });
  expect(s.failures).not.toHaveBeenCalled();
});

it('[AC-F1-06l#11] an SMS code expires 300 seconds after it was sent', async () => {
  const s = setup();
  await s.service.sendSms(s.caller);
  s.clock.advanceMs(300_000);
  expect(await s.service.stepUp(s.caller, 'sms', s.outbox.at(-1)!.code)).toEqual({ code: 20003 });
});

it('[AC-F1-06l#4] [AC-F1-06l#5] me: ticked points in enum order, masked phone or null', async () => {
  const s = setup({ ticked: ['fund.recon', 'retired.unknown', 'user.list'] });
  const result = await s.service.me(s.caller);
  expect(result).toEqual({
    code: 0,
    me: {
      admin_id: s.caller.adminId,
      username: 'finance-jia',
      is_super: false,
      verify_phone_masked: '138****5678',
      permissions: [
        { key: 'user.list', step_up_tier: null, step_up_operations: [] },
        {
          key: 'fund.recon',
          step_up_tier: null,
          step_up_operations: [{ operation: 'fund.recon.balance_recalc', tier: 'sms' }],
        },
      ],
    },
  });
  const empty = setup({ phone: false });
  expect(await empty.service.me(empty.caller)).toMatchObject({
    code: 0,
    me: { verify_phone_masked: null, permissions: [] },
  });
});

it('[AC-F1-06l#9] the code is recorded (current and in the history) before the SMS goes out', async () => {
  const s = setup();
  expect((await s.service.sendSms(s.caller)).code).toBe(0);
  const first = s.outbox.at(-1)!.code;
  expect(s.atSend[0]).toEqual({ current: s.hashOf(first), history: [s.hashOf(first)] });
  s.clock.advanceMs(60_000);
  expect((await s.service.sendSms(s.caller)).code).toBe(0);
  const second = s.outbox.at(-1)!.code;
  expect(s.atSend[1]).toEqual({
    current: s.hashOf(second),
    history: [s.hashOf(first), s.hashOf(second)],
  });
});

it('[AC-F1-06l#9] a failed record write sends nothing, frees the slot and answers 50001', async () => {
  const s = setup();
  s.codes.state.failStore = true;
  expect(await s.service.sendSms(s.caller)).toEqual({ code: 50001 });
  expect(s.atSend).toEqual([]);
  s.codes.state.failStore = false;
  expect((await s.service.sendSms(s.caller)).code).toBe(0);
  expect(s.outbox).toHaveLength(1);
});

it('[AC-F1-06l#9] a rejected send withdraws the new code and the slot; the replaced code stays void', async () => {
  const s = setup();
  await s.service.sendSms(s.caller);
  const old = s.outbox.at(-1)!.code;
  s.clock.advanceMs(60_000);
  s.results.push('rejected');
  expect(await s.service.sendSms(s.caller)).toEqual({ code: 50001 });
  expect(s.codes.state.current).toBeUndefined();
  expect(s.codes.state.history.map((v) => v.hash)).toEqual([s.hashOf(old)]);
  expect(await s.service.stepUp(s.caller, 'sms', old)).toEqual({ code: 20003 });
  expect((await s.service.sendSms(s.caller)).code).toBe(0);
  expect(s.failures).not.toHaveBeenCalled();
});

it('[AC-F1-06l#9] an unknown outcome keeps the code and the slot', async () => {
  const s = setup();
  s.results.push('unknown');
  expect((await s.service.sendSms(s.caller)).code).toBe(0);
  expect(s.codes.state.current?.hash).toBe(s.hashOf(s.outbox[0]!.code));
  expect((await s.service.sendSms(s.caller)).code).toBe(42901);
});

it('[AC-F1-06l#10] [AC-F1-06l#11] a replaced code past its own expiry is 20003, not a counted 20002', async () => {
  const s = setup();
  await s.service.sendSms(s.caller);
  const old = s.outbox.at(-1)!.code;
  s.clock.advanceMs(250_000);
  await s.service.sendSms(s.caller);
  s.clock.advanceMs(100_000);
  // The old code expired 50 seconds ago; the new one is still valid.
  expect(await s.service.stepUp(s.caller, 'sms', old)).toEqual({ code: 20003 });
  const current = s.outbox.at(-1)!.code;
  const wrong = String((Number(current) + 1) % 1_000_000).padStart(6, '0');
  expect(await s.service.stepUp(s.caller, 'sms', wrong)).toEqual({ code: 20002 });
  expect(s.failures).toHaveBeenCalledTimes(1);
  expect((await s.service.stepUp(s.caller, 'sms', current)).code).toBe(0);
});

it('[AC-F1-06l#11] the expired current code, or any code once it expired, is 20003 and not counted', async () => {
  const s = setup();
  await s.service.sendSms(s.caller);
  const code = s.outbox.at(-1)!.code;
  s.clock.advanceMs(300_000);
  expect(await s.service.stepUp(s.caller, 'sms', code)).toEqual({ code: 20003 });
  expect(await s.service.stepUp(s.caller, 'sms', '000000')).toEqual({ code: 20003 });
  expect(s.failures).not.toHaveBeenCalled();
});

it('[AC-F1-06l#9] without a configured sender: 50001, no code kept, no slot taken', async () => {
  const s = setup({ sender: NO_SMS_SENDER });
  expect(await s.service.sendSms(s.caller)).toEqual({ code: 50001 });
  expect(s.codes.state).toMatchObject({ current: undefined, history: [] });
  expect(await s.service.sendSms(s.caller)).toEqual({ code: 50001 });
  expect(
    await NO_SMS_SENDER.send({ app_id: 'couli', phone: '1', purpose: 'step_up', code: '1' }),
  ).toBe('rejected');
});

it('[AC-F1-06l#10] [AC-F1-06l#11] an old code whose record lapsed past 300 seconds is still 20003 after a resend', async () => {
  const s = setup();
  await s.service.sendSms(s.caller);
  const old = s.outbox.at(-1)!.code;
  s.clock.advanceMs(301_000);
  // The current-code record is gone (Redis cleanup); the history is kept apart from it.
  s.codes.state.current = undefined;
  expect((await s.service.sendSms(s.caller)).code).toBe(0);
  const current = s.outbox.at(-1)!.code;
  expect(await s.service.stepUp(s.caller, 'sms', old)).toEqual({ code: 20003 });
  expect(s.failures).not.toHaveBeenCalled();
  expect((await s.service.stepUp(s.caller, 'sms', current)).code).toBe(0);
});

it('[AC-F1-06l#10] codes sent within 24 hours answer 20003; an older one is a counted 20002', async () => {
  const s = setup();
  await s.service.sendSms(s.caller);
  const dayOld = s.outbox.at(-1)!.code;
  s.clock.advanceMs(STEP_UP_SMS_HISTORY_MS - 120_000);
  await s.service.sendSms(s.caller);
  const recent = s.outbox.at(-1)!.code;
  s.clock.advanceMs(60_000);
  await s.service.sendSms(s.caller);
  const current = s.outbox.at(-1)!.code;
  // dayOld was sent 23h59m ago: still remembered.
  expect(await s.service.stepUp(s.caller, 'sms', dayOld)).toEqual({ code: 20003 });
  expect(await s.service.stepUp(s.caller, 'sms', recent)).toEqual({ code: 20003 });
  expect(s.failures).not.toHaveBeenCalled();
  s.clock.advanceMs(60_000);
  // Now 24 hours have passed since dayOld was sent; the current code is still valid.
  expect(await s.service.stepUp(s.caller, 'sms', dayOld)).toEqual({ code: 20002 });
  expect(s.failures).toHaveBeenCalledTimes(1);
  expect((await s.service.stepUp(s.caller, 'sms', current)).code).toBe(0);
});

it('[AC-F1-06l#10] the history keeps the newest 32 codes; the oldest beyond that is a counted 20002', async () => {
  const s = setup();
  const sent: string[] = [];
  for (let i = 0; i < STEP_UP_SMS_HISTORY_KEEP + 1; i += 1) {
    expect((await s.service.sendSms(s.caller)).code).toBe(0);
    sent.push(s.outbox.at(-1)!.code);
    s.clock.advanceMs(60_000);
  }
  expect(s.codes.state.history).toHaveLength(STEP_UP_SMS_HISTORY_KEEP);
  s.codes.state.current = { hash: s.hashOf(sent.at(-1)!), exp: s.clock.now().getTime() + 1 };
  expect(await s.service.stepUp(s.caller, 'sms', sent[1]!)).toEqual({ code: 20003 });
  expect(s.failures).not.toHaveBeenCalled();
  expect(await s.service.stepUp(s.caller, 'sms', sent[0]!)).toEqual({ code: 20002 });
  expect(s.failures).toHaveBeenCalledTimes(1);
});
