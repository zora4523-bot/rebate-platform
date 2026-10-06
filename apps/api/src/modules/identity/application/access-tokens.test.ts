import { generateKeyPairSync } from 'node:crypto';
import { errorCodes } from '@couli/contracts-ts';
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  RequestRejection,
  contractAuthRoutes,
  contractSigningRoutes,
  type RequestCheckInput,
  type TokenPrincipal,
} from '../../platform/index.ts';
import {
  TOKEN_REJECTIONS,
  TokenRejection,
  createTokenCheck,
  createTokenKeyProvider,
  createTokenService,
} from './access-tokens.ts';

const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000010',
  app_id: 'couli',
  sid: 'session-unit',
  device_id: '019a0000-0000-7000-8000-000000000001',
  scp: 'full',
};

function service() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const clock = new FixedClock('2026-10-06T04:00:00.000Z');
  return createTokenService({
    clock,
    keys: {
      kid: 'unit',
      privateKey: pair.privateKey,
      publicKeys: new Map([['unit', pair.publicKey]]),
    },
  });
}

function input(
  route: { method: string; path: string },
  headers: RequestCheckInput['headers'],
): RequestCheckInput {
  return {
    id: 'unit',
    method: route.method,
    url: route.path,
    routeTemplate: route.path,
    headers,
    rawBody: Buffer.alloc(0),
  };
}

function route(predicate: (auth: string, signed: boolean) => boolean) {
  const signed = new Set(
    contractSigningRoutes()
      .filter((candidate) => candidate.signed)
      .map((candidate) => `${candidate.method} ${candidate.path}`),
  );
  const found = contractAuthRoutes().find((candidate) =>
    predicate(candidate.auth, signed.has(`${candidate.method} ${candidate.path}`)),
  );
  expect(found).toBeDefined();
  return found!;
}

it('[BR-ID-01] 10001 / 10002 / 10403 carry the contract status and the first clause of its meaning', () => {
  for (const code of [10001, 10002, 10403] as const) {
    const rejection = new TokenRejection(code);
    expect(rejection).toBeInstanceOf(RequestRejection);
    expect(rejection.statusCode).toBe(errorCodes[code].http);
    expect(errorCodes[code].meaning.startsWith(TOKEN_REJECTIONS[code].msg)).toBe(true);
    expect(rejection.message).toBe(TOKEN_REJECTIONS[code].msg);
  }
});

it('[BR-ID-07] staging / prod without a key refuse; a hand-built bad key is refused without its value', async () => {
  for (const appEnv of ['staging', 'prod'] as const) {
    await expect(createTokenKeyProvider(appEnv, null)).rejects.toThrow(/JWT_PRIVATE_KEY_PEM/);
  }
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const refusal = createTokenKeyProvider('test', {
    kid: 'k',
    privateKeyPem: rsa,
    verificationKeys: {},
  });
  await expect(refusal).rejects.toThrow(/JWT_PRIVATE_KEY_PEM/);
  await expect(refusal).rejects.not.toThrow(rsa.split('\n')[1]!);
  const ephemeral = await createTokenKeyProvider('local', null);
  expect([...ephemeral.publicKeys.keys()]).toEqual([ephemeral.kid]);
  expect((await createTokenKeyProvider('local', null)).kid).not.toBe(ephemeral.kid);
});

it('[BR-ID-07] issuing refuses a principal without the five claims', async () => {
  const tokens = service();
  await expect(
    tokens.issueAccess({ ...PRINCIPAL, scp: 'admin' as TokenPrincipal['scp'] }),
  ).rejects.toThrow(TypeError);
  await expect(tokens.issueAccess({ ...PRINCIPAL, uid: '' })).rejects.toThrow(TypeError);
});

it('[BR-ID-01] the Bearer scheme is case-insensitive; the check attaches a frozen principal', async () => {
  const tokens = service();
  const check = createTokenCheck({
    tokens,
    sessions: { find: async () => ({ revoked_at: null }) },
  });
  const login = route((auth) => auth === 'login');
  const request = input(login, {
    'x-app-id': 'couli',
    authorization: `bearer ${await tokens.issueAccess(PRINCIPAL)}`,
  });
  await check(request);
  expect(request.principal).toEqual(PRINCIPAL);
  expect(Object.isFrozen(request.principal)).toBe(true);
});

it('[BR-ID-01] an unsigned anonymous request has no stage ③; a refused token never reads the session', async () => {
  const tokens = service();
  const find = vi.fn(async () => ({ revoked_at: null }));
  const check = createTokenCheck({ tokens, sessions: { find } });
  const unsignedNone = route((auth, signed) => auth === 'none' && !signed);
  await check(input(unsignedNone, {}));
  await expect(
    check(
      input(
        route((auth) => auth === 'login'),
        { authorization: 'Bearer a.b.c' },
      ),
    ),
  ).rejects.toMatchObject({ code: 10002 });
  expect(find).not.toHaveBeenCalled();
});

it('[BR-ID-01] optional with a valid token compares X-App-Id with the token, not the device', async () => {
  const tokens = service();
  const check = createTokenCheck({
    tokens,
    sessions: { find: async () => ({ revoked_at: null }) },
  });
  const optional = route((auth) => auth === 'optional');
  const token = await tokens.issueAccess(PRINCIPAL);
  const request = input(optional, { 'x-app-id': 'other', authorization: `Bearer ${token}` });
  request.verifiedDevice = { deviceId: PRINCIPAL.device_id, appId: 'other' };
  await expect(check(request)).rejects.toMatchObject({ code: 10403, statusCode: 403 });
});
