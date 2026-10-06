import { createHash, createHmac, verify } from 'node:crypto';
import { expect, it } from 'vitest';
import { createTokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { PRINCIPAL, decode, fixture, keys, signedJwt } from './kit.ts';

for (const scp of ['full', 'deletion_only'] as const) {
  it(`[BR-ID-07] ${scp} access_token 是带 kid 的 ES256，五项 claims 与两小时有效期可独立验证`, async () => {
    const { tokens, keyring, clock } = fixture();
    const token = await tokens.issueAccess({ ...PRINCIPAL, scp });
    const jwt = decode(token);
    expect(jwt.header).toMatchObject({ alg: 'ES256', kid: keyring.kid });
    expect(jwt.payload).toMatchObject({ ...PRINCIPAL, scp, iat: clock.now().getTime() / 1000 });
    expect(Number(jwt.payload['exp']) - Number(jwt.payload['iat'])).toBe(7200);
    expect(jwt.signature).toHaveLength(64);
    expect(
      verify(
        'sha256',
        jwt.input,
        { key: keyring.publicKey, dsaEncoding: 'ieee-p1363' },
        jwt.signature,
      ),
    ).toBe(true);
    expect(await tokens.verifyAccess(token)).toEqual({ ...PRINCIPAL, scp });
  });
}

it('[BR-ID-07] 注入时钟推进7199秒仍有效，7260秒起返回10002', async () => {
  const { tokens, clock } = fixture();
  const token = await tokens.issueAccess(PRINCIPAL);
  clock.advanceMs(7199_000);
  expect(await tokens.verifyAccess(token)).toEqual(PRINCIPAL);
  clock.advanceMs(61_000);
  await expect(tokens.verifyAccess(token)).rejects.toMatchObject({ code: 10002, statusCode: 401 });
});

for (const attack of [
  'none',
  'HS256',
  'payload',
  'other-key',
  'unknown-kid',
  'missing-kid',
  'missing-exp',
  'expired',
  'issuer',
  'audience',
  'missing-uid',
  'missing-app_id',
  'missing-sid',
  'missing-device_id',
  'missing-scp',
  'bad-scp',
] as const) {
  it(`[BR-ID-07][BR-ID-01] 自造负例 ${attack} 必须统一为10002`, async () => {
    const { tokens, keyring, clock } = fixture();
    const original = await tokens.issueAccess(PRINCIPAL);
    const { header, payload } = decode(original);
    let bad: string;
    if (attack === 'none') {
      bad = `${Buffer.from(JSON.stringify({ ...header, alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
    } else if (attack === 'HS256') {
      const input = `${Buffer.from(JSON.stringify({ ...header, alg: 'HS256' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
      bad = `${input}.${createHmac(
        'sha256',
        keyring.publicKey.export({ type: 'spki', format: 'pem' }),
      )
        .update(input)
        .digest('base64url')}`;
    } else if (attack === 'payload') {
      const segments = original.split('.');
      segments[1] = Buffer.from(JSON.stringify({ ...payload, uid: 'attacker' })).toString(
        'base64url',
      );
      bad = segments.join('.');
    } else {
      if (attack === 'unknown-kid') header['kid'] = 'unknown-local-kid';
      if (attack === 'missing-kid') delete header['kid'];
      if (attack === 'expired') payload['exp'] = clock.now().getTime() / 1000 - 60;
      if (attack === 'issuer') payload['iss'] = 'untrusted-issuer';
      if (attack === 'audience') payload['aud'] = 'not-an-app-audience';
      if (attack.startsWith('missing-') && attack !== 'missing-kid')
        delete payload[attack.slice('missing-'.length)];
      if (attack === 'bad-scp') payload['scp'] = 'admin';
      bad = signedJwt(
        header,
        payload,
        attack === 'other-key' ? keys().privateKey : keyring.privateKey,
      );
    }
    await expect(tokens.verifyAccess(bad)).rejects.toMatchObject({ code: 10002, statusCode: 401 });
  });
}

it('[BR-ID-07] 按kid验证轮换前的本地公钥，不只认当前签名密钥', async () => {
  const { tokens, keyring, clock } = fixture();
  const previous = await tokens.issueAccess(PRINCIPAL);
  const next = keys();
  const rotated = createTokenService({
    clock,
    keys: {
      ...next,
      kid: 'next-kid',
      publicKeys: new Map([
        [keyring.kid, keyring.publicKey],
        ['next-kid', next.publicKey],
      ]),
    },
  });
  expect(await rotated.verifyAccess(previous)).toEqual(PRINCIPAL);
  expect(decode(await rotated.issueAccess(PRINCIPAL)).header['kid']).toBe('next-kid');
});

it('[BR-ID-07] refresh_token为32字节随机串，SHA-256摘要，30天由同一Clock计时', () => {
  const { tokens, clock } = fixture();
  const first = tokens.issueRefresh();
  const second = tokens.issueRefresh();
  expect(first.token).not.toBe(second.token);
  for (const issued of [first, second]) {
    const raw = /^[0-9a-f]{64}$/i.test(issued.token)
      ? Buffer.from(issued.token, 'hex')
      : Buffer.from(issued.token, 'base64url');
    expect(raw).toHaveLength(32);
    expect(
      ['hex', 'base64url'].map((encoding) =>
        createHash('sha256')
          .update(issued.token)
          .digest(encoding as 'hex' | 'base64url'),
      ),
    ).toContain(issued.hash);
    expect(issued.hash).not.toBe(issued.token);
    expect(issued.expireAt.getTime() - clock.now().getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  }
});
