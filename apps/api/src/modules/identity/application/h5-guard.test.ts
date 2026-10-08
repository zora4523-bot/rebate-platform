import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { FixedClock, type RequestCheckInput, type TokenPrincipal } from '../../platform/index.ts';
import {
  H5ReadOnlyRejection,
  createTokenCheck,
  createTokenService,
  isOutsideH5Scope,
  isTokenCheck,
  signScopedToken,
  type TokenKeyProvider,
} from './access-tokens.ts';
import { createH5TokenService } from './h5-token.ts';

const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000010',
  app_id: 'couli',
  sid: 'session-unit',
  device_id: '019a0000-0000-7000-8000-000000000001',
  scp: 'full',
};

function setup() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keys: TokenKeyProvider = {
    kid: 'unit',
    privateKey: pair.privateKey,
    publicKeys: new Map([['unit', pair.publicKey]]),
  };
  const clock = new FixedClock('2026-10-08T02:00:00.000Z');
  const tokens = createTokenService({ clock, keys });
  const revoked = new Set<string>();
  const find = vi.fn(async (_app: string, sid: string) => ({
    revoked_at: revoked.has(sid) ? clock.now() : null,
  }));
  const h5 = createH5TokenService({
    clock,
    keys,
    sessions: { find },
    config: { configValue: async () => null },
  });
  return { keys, clock, tokens, revoked, find, h5 };
}

function input(method: string, path: string, token: string, appId = 'couli'): RequestCheckInput {
  return {
    id: 'unit',
    method,
    url: path,
    routeTemplate: path,
    headers: { 'x-app-id': appId, authorization: `Bearer ${token}` },
    rawBody: Buffer.alloc(0),
  };
}

async function h5Token(
  context: ReturnType<typeof setup>,
  scope?: 'standard' | 'read_only',
): Promise<string> {
  const result = await context.h5.issue({
    principal: PRINCIPAL,
    body: scope === undefined ? {} : { scope },
  });
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('unreachable after assertion');
  return result.data.token;
}

it('[BR-ID-32] an h5_token passes a login GET with the principal of its claims; an access token still does', async () => {
  const context = setup();
  const check = createTokenCheck({ tokens: context.tokens, sessions: { find: context.find } });
  expect(isTokenCheck(check)).toBe(true);
  const read = input('GET', '/v1/me', await h5Token(context));
  await check(read);
  expect(read.principal).toEqual({ ...PRINCIPAL, scp: 'full' });
  const access = input('GET', '/v1/me', await context.tokens.issueAccess(PRINCIPAL));
  await check(access);
  expect(access.principal).toEqual(PRINCIPAL);
});

it('[BR-ID-32] a read_only h5_token on another method is 10403 h5_read_only, through the entry factory', async () => {
  const context = setup();
  const token = await h5Token(context);
  const plain = createTokenCheck({ tokens: context.tokens, sessions: { find: context.find } });
  const write = input('POST', '/v1/consents', token);
  const rejection = await plain(write).catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(H5ReadOnlyRejection);
  expect(rejection).toMatchObject({
    code: 10403,
    statusCode: 403,
    data: { reason: 'h5_read_only' },
  });
  expect(write.principal).toBeUndefined();
  const custom = new Error('custom');
  const wired = createTokenCheck({
    tokens: context.tokens,
    sessions: { find: context.find },
    readOnlyRejection: () => custom,
  });
  await expect(wired(input('POST', '/v1/consents', token))).rejects.toBe(custom);
  const standard = input('POST', '/v1/consents', await h5Token(context, 'standard'));
  await wired(standard);
  expect(standard.principal).toMatchObject({ uid: PRINCIPAL.uid });
});

it('[BR-ID-32] h5 scope: signed, /v1/auth/** and the withdrawal, payout, phone and deletion paths are 10403', async () => {
  const context = setup();
  const token = await h5Token(context, 'standard');
  const check = createTokenCheck({ tokens: context.tokens, sessions: { find: context.find } });
  for (const [method, path] of [
    ['POST', '/v1/auth/h5-token'],
    ['POST', '/v1/auth/sms-codes'],
    ['POST', '/v1/auth/refresh'],
    ['GET', '/v1/withdrawals/:withdrawal_id'],
    ['PUT', '/v1/me/payout-account'],
    ['POST', '/v1/me/deletion/cancel'],
    ['POST', '/v1/links/convert'],
  ] as const) {
    await expect(check(input(method, path, token))).rejects.toMatchObject({ code: 10403 });
  }
  expect(isOutsideH5Scope('GET', '/v1/me')).toBe(false);
  expect(isOutsideH5Scope('GET', '/v1/me/phone')).toBe(true);
  expect(isOutsideH5Scope('GET', '/v1/withdrawals')).toBe(true);
});

it('[BR-ID-32] x-auth none still ignores an access token or an invalid token', async () => {
  const context = setup();
  const check = createTokenCheck({ tokens: context.tokens, sessions: { find: context.find } });
  const signed = (token: string): RequestCheckInput => ({
    ...input('POST', '/v1/auth/refresh', token),
    verifiedDevice: { appId: 'couli', deviceId: PRINCIPAL.device_id },
  });
  await expect(check(signed(await context.tokens.issueAccess(PRINCIPAL)))).resolves.toBeUndefined();
  await expect(check(signed('not-a-token'))).resolves.toBeUndefined();
  expect(context.find).not.toHaveBeenCalled();
  await expect(check(signed(await h5Token(context)))).rejects.toMatchObject({ code: 10403 });
});

it('[BR-ID-32] a revoked issuing session, an expired token or a foreign X-App-Id fail', async () => {
  const context = setup();
  const check = createTokenCheck({ tokens: context.tokens, sessions: { find: context.find } });
  const token = await h5Token(context);
  await expect(check(input('GET', '/v1/me', token, 'another_app'))).rejects.toMatchObject({
    code: 10403,
  });
  context.revoked.add(PRINCIPAL.sid);
  await expect(check(input('GET', '/v1/me', token))).rejects.toMatchObject({ code: 10002 });
  expect(await context.h5.issue({ principal: PRINCIPAL, body: {} })).toEqual({ code: 10002 });
  const later = setup();
  const expiring = await h5Token(later);
  const guard = createTokenCheck({ tokens: later.tokens, sessions: { find: later.find } });
  later.clock.advanceMs(899_999);
  await guard(input('GET', '/v1/me', expiring));
  later.clock.advanceMs(1);
  await expect(guard(input('GET', '/v1/me', expiring))).rejects.toMatchObject({ code: 10002 });
});

it('[BR-ID-32] verifyH5 refuses a step_up_token, an access token and a token without a valid scope', async () => {
  const context = setup();
  const { verifyH5 } = context.tokens;
  if (verifyH5 === undefined) throw new Error('createTokenService must verify h5 tokens');
  const issuedAt = Math.floor(context.clock.now().getTime() / 1000);
  const stepUp = await signScopedToken(context.keys, {
    audience: 'step_up',
    claims: { ...PRINCIPAL, scp: 'standard' },
    issuedAt,
    ttlSeconds: 300,
  });
  await expect(verifyH5(stepUp)).rejects.toMatchObject({ code: 10002 });
  await expect(verifyH5(await context.tokens.issueAccess(PRINCIPAL))).rejects.toMatchObject({
    code: 10002,
  });
  const badScope = await signScopedToken(context.keys, {
    audience: 'h5',
    claims: { ...PRINCIPAL, scp: 'full' },
    issuedAt,
    ttlSeconds: 900,
  });
  await expect(verifyH5(badScope)).rejects.toMatchObject({ code: 10002 });
  await expect(context.tokens.verifyAccess(await h5Token(context))).rejects.toMatchObject({
    code: 10002,
  });
});

it('[BR-ID-32] issue: read_only by default, configured lifetime, expire_at on the second', async () => {
  const context = setup();
  context.clock.set('2026-10-08T02:00:00.700Z');
  const h5 = createH5TokenService({
    clock: context.clock,
    keys: context.keys,
    sessions: { find: context.find },
    config: {
      configValue: async (_app, key) =>
        key === 'auth.h5_token_ttl_sec' ? { value: 120, version: 1 } : null,
    },
  });
  const result = await h5.issue({ principal: PRINCIPAL, body: {} });
  expect(result).toMatchObject({
    code: 0,
    data: { scope: 'read_only', expire_at: '2026-10-08T02:02:00.000Z' },
  });
});
