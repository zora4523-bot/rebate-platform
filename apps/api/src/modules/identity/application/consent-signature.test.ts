// recordConsent's clipboard_auto_import signature check (B1-02zc): it runs risk's verifier only for
// POST /v1/consents whose raw body declares type=clipboard_auto_import, and publishes the device.
import { expect, it } from 'vitest';
import type { RequestCheckInput } from '../../platform/index.ts';
import type { RequestSignatureVerifier } from '../../risk/index.ts';
import { SignatureError } from '../../risk/index.ts';
import { createConsentSignatureCheck, isRecordConsentRoute } from './consent-signature.ts';

const DEVICE = { deviceId: '019a0000-0000-7000-8000-000000000002', appId: 'couli' };

function input(body: string, method = 'POST', routeTemplate = '/v1/consents'): RequestCheckInput {
  return {
    id: 'trace',
    method,
    url: '/v1/consents',
    routeTemplate,
    headers: {},
    rawBody: Buffer.from(body),
  };
}

it('[BR-ID-09][BR-ID-12] only a clipboard_auto_import body on POST /v1/consents is verified; the device is published', async () => {
  const seen: Buffer[] = [];
  const verify: RequestSignatureVerifier = async (request) => {
    seen.push(request.rawBody);
    return DEVICE;
  };
  const check = createConsentSignatureCheck(verify);
  const raw = '{"type":"clipboard_auto_import","version":"v1"}';
  const clipboard = input(raw);
  await check(clipboard);
  expect(clipboard.verifiedDevice).toEqual(DEVICE);
  expect(seen.map(String)).toEqual([raw]);
  for (const other of [
    input('{"type":"privacy","version":1}'),
    input('not json'),
    input('null'),
    input(raw, 'GET'),
    input(raw, 'POST', '/v1/consents/other'),
  ]) {
    await check(other);
    expect(other.verifiedDevice).toBeUndefined();
  }
  expect(seen).toHaveLength(1);
});

it('[BR-ID-09] the verifier rejection (10401 / 10402) ends the request without a device', async () => {
  for (const code of [10401, 10402] as const) {
    const check = createConsentSignatureCheck(async () => {
      throw new SignatureError(code);
    });
    const request = input('{"type":"clipboard_auto_import"}');
    await expect(check(request)).rejects.toMatchObject({ code });
    expect(request.verifiedDevice).toBeUndefined();
  }
});

it('[BR-ID-12] recordConsent is the one unsigned route whose raw body is buffered', () => {
  expect(isRecordConsentRoute('POST', '/v1/consents')).toBe(true);
  expect(isRecordConsentRoute('post', '/v1/consents')).toBe(true);
  expect(isRecordConsentRoute('GET', '/v1/consents')).toBe(false);
  expect(isRecordConsentRoute('POST', '/v1/devices')).toBe(false);
  expect(isRecordConsentRoute('POST', undefined)).toBe(false);
});
