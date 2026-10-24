// Unit tests of the admin login use cases and the admin request check (F1-06k) over in-memory
// doubles of admin_users and Redis; the SQL and Redis scripts themselves run in
// test/spec/admin/auth against PG and Redis. No database, no network, no port.
import { randomBytes } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { beforeAll, expect, it } from 'vitest';
import {
  FixedClock,
  RequestRejection,
  type RedisNamespace,
  type RedisScriptOptions,
  type RequestCheckInput,
} from '../../platform/index.ts';
import {
  ADMIN_LOCK_MS,
  ADMIN_LOCK_THRESHOLD,
  createIpAllowlist,
  isLocked,
  later,
} from '../domain/login-policy.ts';
import { createTotpVerifier, hotp, decodeBase32, totpTimeStep } from '../domain/totp.ts';
import type {
  AccountAudit,
  AdminAccount,
  AdminAccounts,
  FailureOutcome,
  WriteOutcome,
} from '../infra/admin-accounts.ts';
import type { AdminRevocations } from '../infra/admin-revocations.ts';
import { createAdminSessions } from '../infra/admin-sessions.ts';
import { createLoginTickets } from '../infra/login-tickets.ts';
import { createMemoryTotpReplayStore } from '../infra/totp-replay-memory.ts';
import { createAdminRequestCheck } from './admin-check.ts';
import { ADMIN_AUTH_AUDIT, createAdminAuthService } from './admin-login.ts';
import { createAdminTokens } from './admin-tokens.ts';
import { encodeBase32, hashAdminPassword } from './bootstrap.ts';

const NOW = '2026-10-09T02:00:00.000Z';
const ID = '019a0000-0000-7000-8000-0000000000a1';
let initialHash: string;
const INITIAL = 'initial-password-1';

beforeAll(async () => {
  initialHash = await hashAdminPassword(INITIAL);
}, 30_000);

/** Redis double: GET / SET and the three scripts of the stores, by their effect. */
function memoryRedis(): RedisNamespace & { keys(): string[] } {
  const data = new Map<string, string>();
  return {
    keys: () => [...data.keys()],
    get: (key) => Promise.resolve(data.get(key) ?? null),
    set: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    eval: (script: string, options: RedisScriptOptions) => {
      const key = options.keys[0]!;
      if (script.includes("'DEL', KEYS[1]) end")) {
        const value = data.get(key) ?? null;
        data.delete(key);
        return Promise.resolve(value);
      }
      if (script.includes("'XX'")) {
        if (!data.has(key)) return Promise.resolve(0);
        data.set(key, options.args[0]!);
        return Promise.resolve(1);
      }
      data.delete(key);
      return Promise.resolve(1);
    },
  };
}

/** admin_users double with the semantics of infra/admin-accounts.ts. */
function memoryAccounts(clock: FixedClock, initial: AdminAccount) {
  let row = initial;
  const audits: string[] = [];
  /** Runs once right after the next read returned (a write committed in between, B1-34h). */
  let afterRead: (() => void) | undefined;
  const read = (found: boolean): Promise<AdminAccount | undefined> => {
    const value = found ? row : undefined;
    const hook = afterRead;
    afterRead = undefined;
    hook?.();
    return Promise.resolve(value);
  };
  const unlocked = () => !isLocked(row.lockedUntil, clock.now());
  /** The infra writes are conditional on the row_version read (B1-34h review r1 S1). */
  const moved = (account: AdminAccount) => account.rowVersion !== row.rowVersion;
  const accounts: AdminAccounts = {
    byLoginName: (name) => read(name === row.loginName),
    byId: (_app, id) => read(id === row.id),
    recordFailure(_account, lockAudit): Promise<FailureOutcome> {
      if (!unlocked()) {
        return Promise.resolve({ kind: 'already_locked', lockedUntil: row.lockedUntil! });
      }
      const base = row.lockedUntil === null ? row.failedLoginCount : 0;
      const count = base + 1;
      const lockedUntil = count >= ADMIN_LOCK_THRESHOLD ? later(clock.now(), ADMIN_LOCK_MS) : null;
      row = { ...row, failedLoginCount: count, lockedUntil };
      if (lockedUntil === null) return Promise.resolve({ kind: 'counted', count });
      audits.push(lockAudit(lockedUntil).action);
      return Promise.resolve({ kind: 'locked', lockedUntil });
    },
    appendAudit(_account, audit: AccountAudit) {
      audits.push(audit.action);
      return Promise.resolve();
    },
    completeLogin(account, list): Promise<WriteOutcome> {
      if (moved(account)) return Promise.resolve({ kind: 'conflict' });
      if (!unlocked()) return Promise.resolve({ kind: 'locked', lockedUntil: row.lockedUntil! });
      row = { ...row, failedLoginCount: 0, lockedUntil: null };
      audits.push(...list.map((audit) => audit.action));
      return Promise.resolve({ kind: 'written' });
    },
    changeInitialPassword(account, hash, audit): Promise<WriteOutcome> {
      if (moved(account)) return Promise.resolve({ kind: 'conflict' });
      if (!unlocked()) return Promise.resolve({ kind: 'locked', lockedUntil: row.lockedUntil! });
      if (!row.passwordMustChange) return Promise.resolve({ kind: 'conflict' });
      row = { ...row, passwordHash: hash, passwordMustChange: false };
      audits.push(audit.action);
      return Promise.resolve({ kind: 'written' });
    },
    bindTotp(account, cipher, list): Promise<WriteOutcome> {
      if (moved(account)) return Promise.resolve({ kind: 'conflict' });
      if (!unlocked()) return Promise.resolve({ kind: 'locked', lockedUntil: row.lockedUntil! });
      if (row.totpBoundAt !== null) return Promise.resolve({ kind: 'conflict' });
      row = {
        ...row,
        totpSecretCipher: cipher,
        totpBoundAt: clock.now(),
        failedLoginCount: 0,
        lockedUntil: null,
      };
      audits.push(...list.map((audit) => audit.action));
      return Promise.resolve({ kind: 'written' });
    },
  };
  return {
    accounts,
    audits,
    row: () => row,
    /** A super admin write committing right after the next read (row_version + 1). */
    commitAfterNextRead(patch: Partial<AdminAccount>, then?: () => void) {
      afterRead = () => {
        row = { ...row, ...patch, rowVersion: row.rowVersion + 1 };
        then?.();
      };
    },
  };
}

/** Field cipher double: binds the context, never the real envelope. */
const crypto = {
  encrypt: (plain: string, context: string) => `${context}|${Buffer.from(plain).toString('hex')}`,
  decrypt: (cipher: string, context: string) => {
    const [given, hex] = cipher.split('|');
    if (given !== context) throw new Error('context mismatch');
    return Buffer.from(hex!, 'hex').toString();
  },
};

function codeOf(secret: string, clock: FixedClock): string {
  return hotp(decodeBase32(secret), totpTimeStep(clock.now()), 6);
}

function setup(patch: Partial<AdminAccount> = {}) {
  const clock = new FixedClock(NOW);
  const secret = encodeBase32(randomBytes(20));
  const context = `admin_users.totp_secret:couli:${ID}`;
  const store = memoryAccounts(clock, {
    id: ID,
    appId: 'couli',
    loginName: 'ops-yi',
    passwordHash: initialHash,
    totpSecretCipher: Buffer.from(crypto.encrypt(secret, context)),
    totpBoundAt: clock.now(),
    isSuper: false,
    status: 'active',
    passwordMustChange: false,
    failedLoginCount: 0,
    lockedUntil: null,
    rowVersion: 0,
    ...patch,
  });
  const redis = memoryRedis();
  let voidedAtMs: number | null = null;
  const revocations: AdminRevocations = {
    voidBefore: (_account, atMs) => {
      voidedAtMs = atMs;
      return Promise.resolve();
    },
    voidedAt: () => Promise.resolve(voidedAtMs),
  };
  const tokens = createAdminTokens({ key: new Uint8Array(randomBytes(32)), clock });
  const sessions = createAdminSessions({ redis, clock });
  const service = createAdminAuthService({
    clock,
    accounts: store.accounts,
    tickets: createLoginTickets({ redis, clock }),
    sessions,
    tokens,
    totp: createTotpVerifier({
      clock,
      crypto,
      replay: createMemoryTotpReplayStore({ clock }),
      digits: 6,
    }),
    crypto,
    issuer: 'Couli Admin test',
    revocations,
  });
  const check = createAdminRequestCheck({
    clock,
    allows: createIpAllowlist(null),
    tokens,
    sessions: () => sessions,
    accounts: () => store.accounts,
  });
  return { clock, secret, store, redis, service, check, revocations };
}

const request = (token: string, url = '/admin/v1/me/permissions'): RequestCheckInput => ({
  id: 'trace',
  method: 'GET',
  url,
  routeTemplate: url,
  ip: '127.0.0.1',
  headers: { authorization: `Bearer ${token}` },
  rawBody: Buffer.alloc(0),
});

it('[AC-F1-06k] password then code signs in once; the ticket is one-time and bound to its step', async () => {
  const { clock, secret, service, store, redis } = setup({ failedLoginCount: 2 });
  const step = await service.login({ username: 'ops-yi', password: INITIAL, ip: '127.0.0.1' });
  expect(step).toMatchObject({ code: 0, next: 'totp', expiresAt: later(clock.now(), 300_000) });
  if (step.code !== 0 || !('ticket' in step)) throw new Error('no ticket');
  expect(store.row().failedLoginCount).toBe(2);
  expect(redis.keys().join()).not.toContain(step.ticket);
  expect(await service.bindTotp({ ticket: step.ticket, code: '000000', ip: null })).toEqual({
    code: 10001,
  });
  const session = await service.verifyTotp({
    ticket: step.ticket,
    code: codeOf(secret, clock),
    ip: null,
  });
  expect(session).toMatchObject({ code: 0, idleTimeoutSec: 1800 });
  expect(store.row().failedLoginCount).toBe(0);
  expect(store.audits).toEqual([ADMIN_AUTH_AUDIT.login]);
  expect(
    await service.verifyTotp({ ticket: step.ticket, code: codeOf(secret, clock), ip: null }),
  ).toEqual({ code: 10001 });
}, 30_000);

it('[AC-F1-06k] the fifth failure locks with 10009; the lock refuses the right password and ends after 30 minutes', async () => {
  const { clock, service, store } = setup({ failedLoginCount: 3 });
  const wrong = { username: 'ops-yi', password: 'wrong-password', ip: null };
  expect(await service.login(wrong)).toEqual({ code: 10008 });
  const until = later(clock.now(), ADMIN_LOCK_MS);
  expect(await service.login(wrong)).toEqual({ code: 10009, lockedUntil: until });
  expect(store.audits).toEqual([ADMIN_AUTH_AUDIT.locked]);
  expect(await service.login({ ...wrong, password: INITIAL })).toEqual({
    code: 10009,
    lockedUntil: until,
  });
  clock.advanceMs(ADMIN_LOCK_MS);
  expect(await service.login(wrong)).toEqual({ code: 10008 });
  expect(store.row().failedLoginCount).toBe(1);
  expect(await service.login({ username: 'nobody', password: 'x', ip: null })).toEqual({
    code: 10008,
  });
}, 60_000);

it('[AC-F1-06k] a wrong code keeps the ticket, counts, and the lock answers 10009 for the same ticket', async () => {
  const { clock, secret, service, store } = setup({ failedLoginCount: 3 });
  const step = await service.login({ username: 'ops-yi', password: INITIAL, ip: null });
  if (step.code !== 0 || !('ticket' in step)) throw new Error('no ticket');
  const wrong = codeOf(secret, clock) === '000000' ? '111111' : '000000';
  expect(await service.verifyTotp({ ticket: step.ticket, code: wrong, ip: null })).toEqual({
    code: 20002,
    reason: 'totp_invalid',
  });
  const locked = await service.verifyTotp({ ticket: step.ticket, code: wrong, ip: null });
  expect(locked).toMatchObject({ code: 10009 });
  expect(
    await service.verifyTotp({ ticket: step.ticket, code: codeOf(secret, clock), ip: null }),
  ).toMatchObject({ code: 10009 });
  expect(store.row().failedLoginCount).toBe(5);
}, 30_000);

it('[AC-F1-06k] a ticket expires at five minutes by the Clock, not by Redis', async () => {
  const { clock, secret, service } = setup();
  const step = await service.login({ username: 'ops-yi', password: INITIAL, ip: null });
  if (step.code !== 0 || !('ticket' in step)) throw new Error('no ticket');
  clock.advanceMs(300_000);
  expect(
    await service.verifyTotp({ ticket: step.ticket, code: codeOf(secret, clock), ip: null }),
  ).toEqual({ code: 10001 });
}, 30_000);

it('[AC-F1-06k] first login: change the initial password, then bind; rejected passwords keep the ticket', async () => {
  const { clock, service, store } = setup({
    passwordMustChange: true,
    totpBoundAt: null,
    totpSecretCipher: null,
  });
  const first = await service.login({ username: 'ops-yi', password: INITIAL, ip: null });
  expect(first).toMatchObject({ code: 0, next: 'change_password' });
  if (first.code !== 0 || !('ticket' in first)) throw new Error('no ticket');
  expect(await service.bindingSecret({ ticket: first.ticket })).toEqual({ code: 10001 });
  for (const rejected of ['short', INITIAL, 'ops-yi', 'x'.repeat(129)]) {
    expect(
      await service.changeInitialPassword({
        ticket: first.ticket,
        newPassword: rejected,
        ip: null,
      }),
    ).toEqual({ code: 20001 });
  }
  const next = await service.changeInitialPassword({
    ticket: first.ticket,
    newPassword: 'a-new-password',
    ip: null,
  });
  expect(next).toMatchObject({ code: 0, next: 'bind_totp' });
  if (next.code !== 0 || !('ticket' in next)) throw new Error('no ticket');
  expect(store.row().passwordMustChange).toBe(false);
  const binding = await service.bindingSecret({ ticket: next.ticket });
  if (binding.code !== 0 || !('secret' in binding)) throw new Error('no secret');
  expect(await service.bindingSecret({ ticket: next.ticket })).toEqual(binding);
  expect(new URL(binding.otpauthUri).searchParams.get('secret')).toBe(binding.secret);
  const wrong = codeOf(binding.secret, clock) === '000000' ? '111111' : '000000';
  expect(await service.bindTotp({ ticket: next.ticket, code: wrong, ip: null })).toEqual({
    code: 20002,
    reason: 'totp_bind_invalid',
  });
  expect(store.row().totpBoundAt).toBeNull();
  const session = await service.bindTotp({
    ticket: next.ticket,
    code: codeOf(binding.secret, clock),
    ip: null,
  });
  expect(session).toMatchObject({ code: 0 });
  expect(store.row()).toMatchObject({ failedLoginCount: 0, totpBoundAt: clock.now() });
  expect(store.audits).toEqual([
    ADMIN_AUTH_AUDIT.passwordChanged,
    ADMIN_AUTH_AUDIT.totpBound,
    ADMIN_AUTH_AUDIT.login,
  ]);
}, 60_000);

async function signedIn(fixture: ReturnType<typeof setup>): Promise<string> {
  const step = await fixture.service.login({ username: 'ops-yi', password: INITIAL, ip: null });
  if (step.code !== 0 || !('ticket' in step)) throw new Error('no ticket');
  const session = await fixture.service.verifyTotp({
    ticket: step.ticket,
    code: codeOf(fixture.secret, fixture.clock),
    ip: null,
  });
  if (session.code !== 0 || !('token' in session)) throw new Error('no session');
  return session.token;
}

it('[AC-F1-06k] the admin check: idle 30 minutes ends the session, activity renews it, logout revokes it', async () => {
  const fixture = setup();
  const token = await signedIn(fixture);
  const ok = request(token);
  await fixture.check(ok);
  expect(ok.adminPrincipal).toMatchObject({ adminId: ID, appId: 'couli', isSuper: false });
  fixture.clock.advanceMs(1_799_999);
  await fixture.check(request(token));
  fixture.clock.advanceMs(1_800_000);
  await expect(fixture.check(request(token))).rejects.toBeInstanceOf(RequestRejection);

  const again = setup();
  const second = await signedIn(again);
  const principal = request(second);
  await again.check(principal);
  await again.service.logout({ ...principal.adminPrincipal!, ip: null });
  await expect(again.check(request(second))).rejects.toMatchObject({ code: 10001 });
  expect(again.store.audits).toEqual([ADMIN_AUTH_AUDIT.login, ADMIN_AUTH_AUDIT.logout]);
}, 30_000);

it('[AC-F1-06k] the admin check: whitelist first, super routes need a super account, a ticket is no token', async () => {
  const fixture = setup();
  const token = await signedIn(fixture);
  await expect(fixture.check({ ...request(token), ip: '198.51.100.1' })).rejects.toBeInstanceOf(
    HttpException,
  );
  await expect(fixture.check(request(token, '/admin/v1/admins'))).rejects.toMatchObject({
    response: { code: 10403, data: { reason: 'admin_permission_denied' } },
  });
  const step = await fixture.service.login({ username: 'ops-yi', password: INITIAL, ip: null });
  if (step.code !== 0 || !('ticket' in step)) throw new Error('no ticket');
  await expect(fixture.check(request(step.ticket))).rejects.toMatchObject({ code: 10001 });
  // Routes outside /admin/v1 are left alone.
  await expect(
    fixture.check({ ...request('x'), routeTemplate: '/healthz', ip: '198.51.100.1' }),
  ).resolves.toBeUndefined();
}, 30_000);

/** The voiding write of an initial password regeneration as admin-account-writes commits it. */
function regenerated(fixture: ReturnType<typeof setup>) {
  return () => {
    fixture.clock.advanceMs(1);
    void fixture.revocations.voidBefore(
      { appId: 'couli', adminId: ID },
      fixture.clock.now().getTime(),
    );
  };
}

/** The regenerated initial password of the race tests (a placeholder). */
const REGENERATED = 'regen-pw-2';

const ON_INITIAL = { passwordMustChange: true, totpBoundAt: null, totpSecretCipher: null };

it('[AC-B1-34h] a regeneration committed while the login checks the old password voids its ticket', async () => {
  const fixture = setup(ON_INITIAL);
  const replaced = await hashAdminPassword(REGENERATED);
  // The login has read hash(P1); the regeneration commits before the ticket is stored.
  fixture.store.commitAfterNextRead({ passwordHash: replaced }, regenerated(fixture));
  const step = await fixture.service.login({ username: 'ops-yi', password: INITIAL, ip: null });
  expect(step).toMatchObject({ code: 0, next: 'change_password' });
  if (step.code !== 0 || !('ticket' in step)) throw new Error('no ticket');
  fixture.clock.advanceMs(1_000);
  expect(
    await fixture.service.changeInitialPassword({
      ticket: step.ticket,
      newPassword: 'a-new-password',
      ip: null,
    }),
  ).toEqual({ code: 10001 });
  expect(fixture.store.row()).toMatchObject({ passwordHash: replaced, passwordMustChange: true });
}, 60_000);

it('[AC-B1-34h] a regeneration committed between the ticket check and the account read voids the step', async () => {
  for (const visible of [true, false]) {
    const fixture = setup(ON_INITIAL);
    const step = await fixture.service.login({ username: 'ops-yi', password: INITIAL, ip: null });
    if (step.code !== 0 || !('ticket' in step)) throw new Error('no ticket');
    fixture.clock.advanceMs(1_000);
    const replaced = await hashAdminPassword(REGENERATED);
    // visible: the voiding instant is already in Redis when the step checks it; otherwise only
    // the row has moved on (the regeneration still holds the row when the step reads it).
    fixture.store.commitAfterNextRead(
      { passwordHash: replaced },
      visible ? regenerated(fixture) : undefined,
    );
    expect(
      await fixture.service.changeInitialPassword({
        ticket: step.ticket,
        newPassword: 'a-new-password',
        ip: null,
      }),
    ).toEqual({ code: 10001 });
    expect(fixture.store.row()).toMatchObject({ passwordHash: replaced, passwordMustChange: true });
  }
}, 60_000);

it('[AC-B1-34h] a ticket issued before an account change (row_version) cannot continue', async () => {
  const fixture = setup();
  const step = await fixture.service.login({ username: 'ops-yi', password: INITIAL, ip: null });
  if (step.code !== 0 || !('ticket' in step)) throw new Error('no ticket');
  // Disabled and enabled again in between: the row moved on, the ticket is stale.
  fixture.store.commitAfterNextRead({});
  await fixture.store.accounts.byId('couli', ID);
  expect(
    await fixture.service.verifyTotp({
      ticket: step.ticket,
      code: codeOf(fixture.secret, fixture.clock),
      ip: null,
    }),
  ).toEqual({ code: 10001 });
}, 30_000);

it('[AC-B1-34h] a void landing right after the final login write revokes the new session', async () => {
  const fixture = setup();
  const step = await fixture.service.login({ username: 'ops-yi', password: INITIAL, ip: null });
  if (step.code !== 0 || !('ticket' in step)) throw new Error('no ticket');
  const complete = fixture.store.accounts.completeLogin.bind(fixture.store.accounts);
  fixture.store.accounts.completeLogin = async (account, list) => {
    const outcome = await complete(account, list);
    fixture.clock.advanceMs(1);
    await fixture.revocations.voidBefore(
      { appId: 'couli', adminId: ID },
      fixture.clock.now().getTime(),
    );
    return outcome;
  };
  expect(
    await fixture.service.verifyTotp({
      ticket: step.ticket,
      code: codeOf(fixture.secret, fixture.clock),
      ip: null,
    }),
  ).toEqual({ code: 10001 });
  expect(fixture.redis.keys().filter((key) => key.startsWith('session:'))).toEqual([]);
}, 30_000);

/** A bind_totp ticket and its pending secret of an account without an authenticator. */
async function bindStep(fixture: ReturnType<typeof setup>) {
  const step = await fixture.service.login({ username: 'ops-yi', password: INITIAL, ip: null });
  if (step.code !== 0 || !('ticket' in step) || step.next !== 'bind_totp') {
    throw new Error('no bind ticket');
  }
  const binding = await fixture.service.bindingSecret({ ticket: step.ticket });
  if (binding.code !== 0 || !('secret' in binding)) throw new Error('no secret');
  return { ticket: step.ticket, secret: binding.secret };
}

it('[AC-B1-34n] binding the authenticator voids at its open instant rounded down to the whole second; its own session survives', async () => {
  const fixture = setup({ totpBoundAt: null, totpSecretCipher: null });
  fixture.clock.set('2026-10-09T02:00:00.990Z');
  const { ticket, secret } = await bindStep(fixture);
  fixture.clock.set('2026-10-09T02:00:01.200Z');
  const session = await fixture.service.bindTotp({
    ticket,
    code: codeOf(secret, fixture.clock),
    ip: null,
  });
  expect(session).toMatchObject({ code: 0 });
  expect(await fixture.revocations.voidedAt({ appId: 'couli', adminId: ID })).toBe(
    Date.parse('2026-10-09T02:00:01.000Z'),
  );
  expect(fixture.store.row().totpBoundAt).toEqual(fixture.clock.now());
}, 30_000);

it('[AC-B1-34n] a failing voiding write binds nothing: the account stays unbound', async () => {
  const fixture = setup({ totpBoundAt: null, totpSecretCipher: null });
  const { ticket, secret } = await bindStep(fixture);
  fixture.revocations.voidBefore = () => Promise.reject(new Error('redis down'));
  await expect(
    fixture.service.bindTotp({ ticket, code: codeOf(secret, fixture.clock), ip: null }),
  ).rejects.toThrow('redis down');
  expect(fixture.store.row()).toMatchObject({ totpBoundAt: null, totpSecretCipher: null });
  expect(fixture.store.audits).not.toContain(ADMIN_AUTH_AUDIT.totpBound);
}, 30_000);

it('[AC-B1-34n] a wrong binding code records no voiding instant', async () => {
  const fixture = setup({ totpBoundAt: null, totpSecretCipher: null });
  const { ticket, secret } = await bindStep(fixture);
  const wrong = codeOf(secret, fixture.clock) === '000000' ? '111111' : '000000';
  expect(await fixture.service.bindTotp({ ticket, code: wrong, ip: null })).toMatchObject({
    code: 20002,
  });
  expect(await fixture.revocations.voidedAt({ appId: 'couli', adminId: ID })).toBeNull();
}, 30_000);
