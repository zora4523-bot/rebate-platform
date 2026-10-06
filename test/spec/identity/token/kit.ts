import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createTokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type { TokenPrincipal } from '../../../../apps/api/src/modules/platform/http/token-context.ts';
import type { RequestCheckInput } from '../../../../apps/api/src/modules/platform/http/request-checks.ts';
import { contract, METHODS } from '../../risk/signature/kit.ts';
import type { ContractAuth } from '../../../../apps/api/src/modules/platform/http/auth-routes.ts';

export const INSTANT = '2026-10-05T04:00:00.000Z';
export const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000010',
  app_id: 'couli',
  sid: 'test-session-opaque',
  device_id: '019a0000-0000-7000-8000-000000000001',
  scp: 'full',
};
export const HEADERS = {
  'x-app-id': 'couli',
  'x-platform': 'ios',
  'x-app-version': '2.0.0',
  'x-device-id': PRINCIPAL.device_id,
};

export function keys() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { ...pair, kid: 'test-p256', publicKeys: new Map([['test-p256', pair.publicKey]]) };
}

export function fixture() {
  const keyring = keys();
  const clock = new FixedClock(INSTANT);
  const tokens = createTokenService({ clock, keys: keyring });
  return { keyring, clock, tokens };
}

export function decode(token: string) {
  const segments = token.split('.');
  expect(segments).toHaveLength(3);
  return {
    header: JSON.parse(Buffer.from(segments[0]!, 'base64url').toString()) as Record<
      string,
      unknown
    >,
    payload: JSON.parse(Buffer.from(segments[1]!, 'base64url').toString()) as Record<
      string,
      unknown
    >,
    input: Buffer.from(segments.slice(0, 2).join('.')),
    signature: Buffer.from(segments[2]!, 'base64url'),
  };
}

/** Independent JWS constructor for adversarial inputs; never uses the implementation signer. */
export function signedJwt(header: object, payload: object, key: KeyObject): string {
  const input = [header, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

export function request(
  route: { method: string; path: string },
  headers: RequestCheckInput['headers'] = HEADERS,
): RequestCheckInput {
  return {
    id: 'b102h-test',
    method: route.method,
    url: route.path.replace(/:[^/]+/g, 'test-id'),
    routeTemplate: route.path,
    headers,
    rawBody: Buffer.alloc(0),
  };
}

export async function routes() {
  const document = await contract();
  return Object.entries(document.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation = item[method] as (typeof item)[typeof method] & { 'x-auth'?: ContractAuth };
      return operation === undefined
        ? []
        : [
            {
              method: method.toUpperCase(),
              path: path.replace(/\{([^}]+)\}/g, ':$1'),
              auth: operation['x-auth'],
              signed: operation['x-signed'] === true,
              operation,
              parameters: item.parameters,
            },
          ];
    }),
  );
}

export async function routeFor(auth: ContractAuth, signed = false) {
  const found = (await routes()).find((route) => route.auth === auth && route.signed === signed);
  expect(found, `契约必须存在 ${auth}, signed=${String(signed)} 操作`).toBeDefined();
  return found!;
}
