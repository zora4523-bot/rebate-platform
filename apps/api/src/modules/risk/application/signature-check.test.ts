// The stage ① rejections against the contract catalogue (contracts/error-codes.yaml through the
// generated @couli/contracts-ts), and the brand bootstrap reads to tell a signature check apart.
import { errorCodes } from '@couli/contracts-ts';
import { expect, it } from 'vitest';
import { FixedClock, RequestRejection } from '../../platform/index.ts';
import {
  SIGNATURE_REJECTIONS,
  SignatureError,
  createRequestSignatureVerifier,
  createSignatureCheck,
  isSignatureCheck,
} from './signature-check.ts';
import { expectedSignature } from '../domain/request-signature.ts';

it('[BR-ID-09] 10401 and 10402 carry the http status and meaning of contracts/error-codes.yaml', () => {
  for (const code of [10401, 10402] as const) {
    expect(SIGNATURE_REJECTIONS[code]).toEqual({
      http: errorCodes[code].http,
      meaning: errorCodes[code].meaning,
    });
    const error = new SignatureError(code);
    expect(error).toBeInstanceOf(RequestRejection);
    expect({ code: error.code, status: error.statusCode, msg: error.message }).toEqual({
      code,
      status: errorCodes[code].http,
      msg: errorCodes[code].meaning,
    });
  }
});

it('[BR-ID-09] only a check built by createSignatureCheck counts as the signature check', () => {
  const check = createSignatureCheck({
    devices: { findActive: async () => null },
    clock: new FixedClock('2026-10-06T04:00:00Z'),
  });
  expect(isSignatureCheck(check)).toBe(true);
  expect(isSignatureCheck(async () => undefined)).toBe(false);
  expect(isSignatureCheck(undefined)).toBe(false);
  expect(isSignatureCheck('check')).toBe(false);
});

// B1-02zc: the stage ① checks as one function without the x-signed route gate (recordConsent's
// clipboard_auto_import), sharing the guard's codes and nonce keys.
const DEVICE = {
  deviceId: '019a0000-0000-7000-8000-000000000002',
  appId: 'couli',
  installSecret: 's3cret',
};
const AT = new FixedClock('2026-10-06T04:00:00Z');

function nonceStore() {
  const keys: string[] = [];
  const handle = {
    namespace: (name: string) => ({
      eval: async (_script: string, options: { keys: readonly string[] }) => {
        const key = `${name}:${options.keys[0]}`;
        if (keys.includes(key)) return null;
        keys.push(key);
        return 'OK';
      },
    }),
  } as unknown as NonNullable<Parameters<typeof createRequestSignatureVerifier>[0]['redis']>;
  return { keys, handle };
}

function signed(body: string, overrides: Record<string, string> = {}) {
  const timestamp = String(Math.floor(AT.now().getTime() / 1000));
  const nonce = 'a'.repeat(32);
  const rawBody = Buffer.from(body);
  const sign = expectedSignature(DEVICE.installSecret, {
    method: 'POST',
    url: '/v1/consents',
    timestamp,
    nonce,
    body: rawBody,
  }).toString('hex');
  return {
    method: 'POST',
    url: '/v1/consents',
    rawBody,
    headers: {
      'x-device-id': DEVICE.deviceId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-sign': sign,
      ...overrides,
    },
  };
}

it('[BR-ID-09] the single-request verifier needs no x-signed route: verified device, then the nonce replay is 10401', async () => {
  const store = nonceStore();
  const verify = createRequestSignatureVerifier({
    devices: { findActive: async (id) => (id === DEVICE.deviceId ? DEVICE : null) },
    clock: AT,
    redis: store.handle,
  });
  const request = signed('{"type":"clipboard_auto_import"}');
  await expect(verify(request)).resolves.toEqual({ deviceId: DEVICE.deviceId, appId: 'couli' });
  expect(store.keys).toEqual([`risk:nonce:couli:${DEVICE.deviceId}:${'a'.repeat(32)}`]);
  await expect(verify(request)).rejects.toMatchObject({ code: 10401 });
});

it('[BR-ID-09] the single-request verifier: raw bytes other than the signed ones, bad headers 10401; unknown device 10402; no nonce is reserved', async () => {
  const store = nonceStore();
  const verify = createRequestSignatureVerifier({
    devices: { findActive: async (id) => (id === DEVICE.deviceId ? DEVICE : null) },
    clock: AT,
    redis: store.handle,
  });
  const good = signed('{"type":"clipboard_auto_import"}');
  // Same JSON value, different bytes: the signature covers the bytes, not a re-serialisation.
  await expect(
    verify({ ...good, rawBody: Buffer.from('{ "type": "clipboard_auto_import" }') }),
  ).rejects.toMatchObject({ code: 10401 });
  await expect(verify(signed('{}', { 'x-sign': '0'.repeat(64) }))).rejects.toMatchObject({
    code: 10401,
  });
  await expect(verify(signed('{}', { 'x-timestamp': '1000000000' }))).rejects.toMatchObject({
    code: 10401,
  });
  await expect(
    verify(signed('{}', { 'x-device-id': '019a0000-0000-7000-8000-000000000009' })),
  ).rejects.toMatchObject({ code: 10402 });
  expect(store.keys).toEqual([]);
});

it('[BR-ID-09] the stage ① check still skips a route that is not x-signed, so recordConsent is never verified there', async () => {
  const asked: string[] = [];
  const check = createSignatureCheck({
    devices: {
      findActive: async (id) => {
        asked.push(id);
        return null;
      },
    },
    clock: AT,
  });
  const request = { ...signed('{}'), id: 'trace', routeTemplate: '/v1/consents' };
  await expect(check(request)).resolves.toBeUndefined();
  expect(asked).toEqual([]);
  expect(request).not.toHaveProperty('verifiedDevice');
});
