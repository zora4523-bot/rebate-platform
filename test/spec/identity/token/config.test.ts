import { generateKeyPairSync, verify } from 'node:crypto';
import { expect, it } from 'vitest';
import { readJwtKeyConfig } from '../../../../apps/api/src/modules/platform/config/jwt.ts';
import {
  loadConfig,
  ConfigError,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import {
  createTokenKeyProvider,
  createTokenService,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { INSTANT, PRINCIPAL, decode, keys } from './kit.ts';

for (const appEnv of ['local', 'test'] as const) {
  it(`[BR-ID-07] ${appEnv} 没有JWT配置时可生成进程临时P-256密钥`, async () => {
    const result = readJwtKeyConfig(appEnv, {});
    expect(result).toEqual({ jwt: null, problems: [] });
    const provider = await createTokenKeyProvider(appEnv, result.jwt);
    expect(provider.kid.length).toBeGreaterThan(0);
    const token = await createTokenService({
      keys: provider,
      clock: new FixedClock(INSTANT),
    }).issueAccess(PRINCIPAL);
    const jwt = decode(token);
    expect(jwt.header).toMatchObject({ alg: 'ES256', kid: provider.kid });
    expect(provider.publicKeys.has(provider.kid)).toBe(true);
    expect(
      verify(
        'sha256',
        jwt.input,
        { key: provider.publicKeys.get(provider.kid)!, dsaEncoding: 'ieee-p1363' },
        jwt.signature,
      ),
    ).toBe(true);
  });
}

for (const appEnv of ['staging', 'prod'] as const) {
  it(`[BR-ID-07] ${appEnv} 缺JWT配置由密钥提供者在启动时拒绝`, async () => {
    expect(readJwtKeyConfig(appEnv, {}).problems.join(' ')).toMatch(/JWT_/);
    await expect(createTokenKeyProvider(appEnv, null)).rejects.toThrow(/JWT_/);
  });
}

it('[BR-ID-07] PKCS#8私钥与本地旧公钥配置经loadConfig交给签名端口', async () => {
  const pair = keys();
  const previous = keys();
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const verificationKeys = {
    previous: previous.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  const env = {
    APP_ENV: 'test',
    JWT_PRIVATE_KEY_PEM: privateKeyPem,
    JWT_KEY_ID: pair.kid,
    JWT_VERIFY_KEYS_JSON: JSON.stringify(verificationKeys),
  };
  const result = readJwtKeyConfig('test', env);
  expect(result).toEqual({ jwt: { kid: pair.kid, privateKeyPem, verificationKeys }, problems: [] });
  expect(loadConfig(env)).toHaveProperty('jwt', result.jwt);
  const provider = await createTokenKeyProvider('test', result.jwt);
  expect(provider.publicKeys.get('previous')?.export({ type: 'spki', format: 'pem' })).toBe(
    verificationKeys.previous,
  );
  const token = await createTokenService({
    keys: provider,
    clock: new FixedClock(INSTANT),
  }).issueAccess(PRINCIPAL);
  const jwt = decode(token);
  expect(
    verify('sha256', jwt.input, { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature),
  ).toBe(true);
});

for (const kind of ['partial', 'garbage', 'p384', 'rsa', 'bad-json', 'override-active'] as const) {
  it(`[BR-ID-07] 非法JWT配置 ${kind} 被拒绝，错误不回显私钥或配置值`, () => {
    const pair = keys();
    let pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    if (kind === 'p384')
      pem = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
    if (kind === 'rsa')
      pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
    if (kind === 'garbage') pem = 'invalid-secret-sentinel';
    const env = {
      JWT_KEY_ID: 'current',
      ...(kind === 'partial' ? {} : { JWT_PRIVATE_KEY_PEM: pem }),
      ...(kind === 'bad-json' ? { JWT_VERIFY_KEYS_JSON: 'invalid-json-secret' } : {}),
      ...(kind === 'override-active'
        ? {
            JWT_VERIFY_KEYS_JSON: JSON.stringify({
              current: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
            }),
          }
        : {}),
    };
    const result = readJwtKeyConfig('test', env);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.join(' ')).not.toContain(pem);
    expect(result.problems.join(' ')).not.toContain('invalid-json-secret');
    expect(() => loadConfig({ APP_ENV: 'test', ...env })).toThrow(ConfigError);
  });
}
