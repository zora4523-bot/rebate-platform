// Unit tests of the verify-phone use cases over doubles of the stores, the sender and the cipher;
// the SQL and Redis scripts run against real services in the rule tests (test/spec/admin/**).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { AdminDirectoryRow } from '../infra/admin-directory.ts';
import type { AdminProfile, AdminProfiles } from '../infra/admin-profiles.ts';
import type {
  AdminVerifyPhoneWrites,
  VerifyPhoneChange,
} from '../infra/admin-verify-phone-writes.ts';
import type { VerifyPhoneCodeCheck, VerifyPhoneCodes } from '../infra/verify-phone-codes.ts';
import type { AdminSmsSender } from './admin-step-up.ts';
import { createAdminVerifyPhoneService } from './admin-verify-phone.ts';

const APP = 'couli';
const OLD = '13900001111';
const FRESH = '13900002222';

interface Pending {
  phone: string;
  hash: string;
  exp: number;
  wrong: number;
}

/** VerifyPhoneCodes double with the semantics of infra/verify-phone-codes.ts (one account). */
function memoryCodes() {
  let sent: { at: number; reservation: string } | undefined;
  const state: { current: Pending | undefined; history: string[] } = {
    current: undefined,
    history: [],
  };
  const codes: VerifyPhoneCodes = {
    knownHashes: () =>
      Promise.resolve(new Set([...(state.current ? [state.current.hash] : []), ...state.history])),
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
    store: (_app, _admin, pending, _now, exp) => {
      state.history.push(pending.hash);
      state.current = { ...pending, exp, wrong: 0 };
      return Promise.resolve();
    },
    revoke: (_app, _admin, hash) => {
      if (state.current?.hash === hash) state.current = undefined;
      state.history = state.history.filter((item) => item !== hash);
      return Promise.resolve();
    },
    check: (_app, _admin, submitted, nowMs, maxWrong): Promise<VerifyPhoneCodeCheck> => {
      const cur = state.current;
      const live = cur !== undefined && cur.exp > nowMs && cur.phone === submitted.phone;
      if (live && cur.hash === submitted.hash) {
        state.current = undefined;
        return Promise.resolve('ok');
      }
      if (state.history.includes(submitted.hash)) return Promise.resolve('gone');
      if (live) {
        cur.wrong += 1;
        if (cur.wrong >= maxWrong) state.current = undefined;
        return Promise.resolve('wrong');
      }
      return Promise.resolve('gone');
    },
  };
  return { codes, state };
}

function setup(options: { phone?: string | null; targetSuper?: boolean } = {}) {
  const clock = new FixedClock('2026-10-24T02:00:00.000Z');
  const actorId = randomUUID();
  const targetId = randomUUID();
  const encrypt = (value: string, context: string): string => `enc(${context}|${value})`;
  const decrypt = (cipher: string, context: string): string =>
    cipher.replace(`enc(${context}|`, '').replace(/\)$/, '');
  const blindIndex = (value: string, context: string): string => `h(${context}|${value})`;
  const phoneContext = (id: string) => `admin_users.verify_phone:${APP}:${id}`;
  const cipherOf = (id: string, phone: string | null) =>
    phone === null ? null : Buffer.from(encrypt(phone, phoneContext(id)));
  const initial = options.phone === undefined ? OLD : options.phone;
  const profileRows = new Map<string, AdminProfile>([
    [
      actorId,
      {
        id: actorId,
        appId: APP,
        loginName: 'holder',
        isSuper: true,
        status: 'active',
        verifyPhoneCipher: cipherOf(actorId, initial),
      },
    ],
    [
      targetId,
      {
        id: targetId,
        appId: APP,
        loginName: 'target',
        isSuper: options.targetSuper ?? false,
        status: 'active',
        verifyPhoneCipher: cipherOf(targetId, initial),
      },
    ],
  ]);
  const profiles: AdminProfiles = {
    byId: (_app, id) => Promise.resolve(profileRows.get(id)),
    permissionKeys: () => Promise.resolve([]),
  };
  const { codes, state } = memoryCodes();
  const outbox: { phone: string; code: string; purpose: string }[] = [];
  const results: ('accepted' | 'rejected' | 'unknown')[] = [];
  const events: string[] = [];
  const sender: AdminSmsSender = {
    send: (message) => {
      events.push('sms');
      const result = results.shift() ?? 'accepted';
      if (result !== 'rejected') outbox.push(message);
      return Promise.resolve(result);
    },
  };
  const changes: VerifyPhoneChange[] = [];
  const sendAudits: unknown[] = [];
  const writes: AdminVerifyPhoneWrites = {
    async change(input) {
      const row = profileRows.get(input.adminId);
      if (row === undefined) return { kind: 'refused', reason: 'unknown' };
      if (input.bySuper && (row.isSuper || row.id === input.actor)) {
        return { kind: 'refused', reason: 'forbidden' };
      }
      const check = await input.verify();
      if (check !== 'ok') return { kind: 'refused', reason: check };
      changes.push(input);
      const directory: AdminDirectoryRow = {
        id: row.id,
        appId: APP,
        loginName: row.loginName,
        displayName: null,
        isSuper: row.isSuper,
        status: 'active',
        totpBoundAt: clock.now(),
        verifyPhoneCipher: Buffer.from(input.phone.cipher),
        lockedUntil: null,
        createdAt: clock.now(),
        rowVersion: 3,
        permissionKeys: [],
      };
      return { kind: 'written', row: directory, setAt: clock.now() };
    },
    auditSend(input) {
      events.push('audit');
      sendAudits.push(input);
      return Promise.resolve();
    },
  };
  const service = createAdminVerifyPhoneService({
    clock,
    profiles,
    codes,
    sender,
    writes,
    crypto: { encrypt, decrypt, blindIndex },
  });
  const caller = { appId: APP, adminId: actorId, ip: '127.0.0.1' };
  return {
    clock,
    service,
    caller,
    actorId,
    targetId,
    state,
    outbox,
    results,
    events,
    changes,
    sendAudits,
    blindIndex,
    phoneContext,
  };
}

it('[AC-B1-34i] 本人发码：规范化后发到新号（step_up 模板），Redis 只存新号盲索引与验证码哈希，60 秒内限频', async () => {
  const s = setup();
  expect(await s.service.sendMine(s.caller, '+86 139-0000-2222')).toEqual({
    kind: 'sent',
    resendAfterSec: 60,
    expiresInSec: 300,
  });
  expect(s.outbox).toEqual([
    { app_id: APP, phone: FRESH, purpose: 'step_up', code: expect.stringMatching(/^\d{6}$/) },
  ]);
  const code = s.outbox[0]!.code;
  expect(s.state.current).toMatchObject({
    phone: s.blindIndex(FRESH, s.phoneContext(s.actorId)),
    hash: s.blindIndex(code, `admin_users.verify_phone_code:${APP}:${s.actorId}`),
  });
  s.clock.advanceMs(59_999);
  expect(await s.service.sendMine(s.caller, FRESH)).toEqual({ kind: 'limited', retryAfterSec: 1 });
  expect(s.outbox).toHaveLength(1);
});

it('[AC-B1-34i] 发码时新号无效或与当前号相同返回 20001，不发短信', async () => {
  const s = setup();
  expect(await s.service.sendMine(s.caller, '')).toEqual({
    kind: 'fields',
    fields: ['phone'],
    reason: 'phone_invalid',
  });
  expect(await s.service.sendMine(s.caller, '139 0000 1111')).toEqual({
    kind: 'fields',
    fields: ['phone'],
  });
  expect(s.outbox).toEqual([]);
  expect(s.state.current).toBeUndefined();
});

it('[AC-B1-34i] 未登记验证手机号的账号也能发码登记', async () => {
  const s = setup({ phone: null });
  expect(await s.service.sendMine(s.caller, FRESH)).toMatchObject({ kind: 'sent' });
  expect(s.outbox.map((item) => item.phone)).toEqual([FRESH]);
});

it('[AC-B1-34i] 运营商明确拒收时撤回验证码并释放限频位，返回 50001', async () => {
  const s = setup();
  s.results.push('rejected');
  expect(await s.service.sendMine(s.caller, FRESH)).toEqual({ kind: 'failed' });
  expect(s.state.current).toBeUndefined();
  expect(s.state.history).toEqual([]);
  expect(await s.service.sendMine(s.caller, FRESH)).toMatchObject({ kind: 'sent' });
});

it('[AC-B1-34i] 超管代改发码：目标不合法 / 不存在 → admin_id，超管或自己 → 10403；成功时先写审计再发短信', async () => {
  const s = setup();
  expect(await s.service.sendFor(s.caller, 'not-a-uuid', FRESH)).toEqual({
    kind: 'fields',
    fields: ['admin_id'],
  });
  expect(await s.service.sendFor(s.caller, randomUUID(), FRESH)).toEqual({
    kind: 'fields',
    fields: ['admin_id'],
  });
  expect(await s.service.sendFor(s.caller, s.actorId, FRESH)).toEqual({ kind: 'forbidden' });
  expect(s.outbox).toEqual([]);
  expect(await s.service.sendFor(s.caller, s.targetId, FRESH)).toMatchObject({ kind: 'sent' });
  expect(s.events).toEqual(['audit', 'sms']);
  expect(s.sendAudits).toEqual([
    {
      appId: APP,
      actor: s.actorId,
      ip: '127.0.0.1',
      adminId: s.targetId,
      masked: '139****2222',
    },
  ]);
  const superTarget = setup({ targetSuper: true });
  expect(
    await superTarget.service.sendFor(superTarget.caller, superTarget.targetId, FRESH),
  ).toEqual({ kind: 'forbidden' });
});

it('[AC-B1-34i] 本人提交：错码 20002，第 5 次错码作废，之后正确码也 20003；不碰登录失败计数', async () => {
  const s = setup();
  await s.service.sendMine(s.caller, FRESH);
  const code = s.outbox[0]!.code;
  const other = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 4; i += 1) {
    expect(await s.service.changeMine(s.caller, FRESH, other)).toEqual({ kind: 'wrong' });
  }
  expect(await s.service.changeMine(s.caller, FRESH, other)).toEqual({ kind: 'wrong' });
  expect(await s.service.changeMine(s.caller, FRESH, code)).toEqual({ kind: 'gone' });
  expect(s.changes).toEqual([]);
});

it('[AC-B1-34i] 本人提交正确码：写入新号密文与盲索引，返回脱敏号与生效时间；再交返回 20003', async () => {
  const s = setup();
  await s.service.sendMine(s.caller, FRESH);
  const code = s.outbox[0]!.code;
  expect(await s.service.changeMine(s.caller, '+8613900002222', code)).toEqual({
    kind: 'ok',
    masked: '139****2222',
    setAt: s.clock.now(),
  });
  expect(s.changes).toHaveLength(1);
  const change = s.changes[0]!;
  expect(change).toMatchObject({
    actor: s.actorId,
    adminId: s.actorId,
    bySuper: false,
    reason: null,
    phone: {
      cipher: `enc(${s.phoneContext(s.actorId)}|${FRESH})`,
      hmac: s.blindIndex(FRESH, s.phoneContext(s.actorId)),
      masked: '139****2222',
    },
  });
  expect(change.maskedOf(Buffer.from(`enc(${s.phoneContext(s.actorId)}|${OLD})`))).toBe(
    '139****1111',
  );
  expect(await s.service.changeMine(s.caller, FRESH, code)).toEqual({ kind: 'gone' });
});

it('[AC-B1-34i] 本人提交时号码与发码的号不同返回 20003', async () => {
  const s = setup();
  await s.service.sendMine(s.caller, FRESH);
  expect(await s.service.changeMine(s.caller, '13900003333', s.outbox[0]!.code)).toEqual({
    kind: 'gone',
  });
  expect(await s.service.changeMine(s.caller, '12345', '000000')).toEqual({
    kind: 'fields',
    fields: ['phone'],
    reason: 'phone_invalid',
  });
});

it('[AC-B1-34i] 超管代改提交：原因只有空白 → reason，id 不合法 → admin_id；成功返回账号并记原因', async () => {
  const s = setup();
  const body = { phone: FRESH, code: '000000', reason: '本人委托' };
  expect(await s.service.changeFor(s.caller, s.targetId, { ...body, reason: '  ' })).toEqual({
    kind: 'fields',
    fields: ['reason'],
  });
  expect(await s.service.changeFor(s.caller, 'nope', body)).toEqual({
    kind: 'fields',
    fields: ['admin_id'],
  });
  expect(await s.service.changeFor(s.caller, randomUUID(), body)).toEqual({
    kind: 'fields',
    fields: ['admin_id'],
  });
  expect(await s.service.changeFor(s.caller, s.actorId, body)).toEqual({ kind: 'forbidden' });
  expect(await s.service.changeFor(s.caller, s.targetId, body)).toEqual({ kind: 'gone' });

  s.clock.advanceMs(60_000);
  await s.service.sendFor(s.caller, s.targetId, FRESH);
  const answer = await s.service.changeFor(s.caller, s.targetId, {
    ...body,
    code: s.outbox.at(-1)!.code,
  });
  expect(answer).toMatchObject({
    kind: 'ok',
    account: { adminId: s.targetId, verifyPhoneMasked: '139****2222', rowVersion: 3 },
  });
  expect(s.changes.at(-1)).toMatchObject({ bySuper: true, reason: '本人委托', actor: s.actorId });
});
