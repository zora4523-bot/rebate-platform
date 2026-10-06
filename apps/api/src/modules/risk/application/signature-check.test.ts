// The stage ① rejections against the contract catalogue (contracts/error-codes.yaml through the
// generated @couli/contracts-ts), and the brand bootstrap reads to tell a signature check apart.
import { errorCodes } from '@couli/contracts-ts';
import { expect, it } from 'vitest';
import { FixedClock, RequestRejection } from '../../platform/index.ts';
import {
  SIGNATURE_REJECTIONS,
  SignatureError,
  createSignatureCheck,
  isSignatureCheck,
} from './signature-check.ts';

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
