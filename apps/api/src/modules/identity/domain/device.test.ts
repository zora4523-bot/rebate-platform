import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { installSecretContext, isRegistrableDeviceHash, isWellFormedDeviceHash } from './device.ts';

const hash = createHash('sha256').update('e621e1f8-c36c-495a-93fc-0c247a3e6e5f').digest('hex');

it('[AC-B1-02c#4] accepts exactly 64 lowercase hex characters as a device hash', () => {
  expect(isWellFormedDeviceHash(hash)).toBe(true);
  for (const bad of [
    hash.toUpperCase(),
    hash.slice(1),
    `${hash}a`,
    `g${hash.slice(1)}`,
    '',
    ` ${hash.slice(1)}`,
    `${hash}\n`,
    null,
    7,
  ]) {
    expect(isWellFormedDeviceHash(bad)).toBe(false);
  }
});

it('[AC-B1-02c#5] refuses hashes on the invalid list and malformed hashes, and nothing else', () => {
  const zeros = createHash('sha256').update('0').digest('hex');
  const invalid = new Set([zeros]);
  expect(isRegistrableDeviceHash(hash, invalid)).toBe(true);
  expect(isRegistrableDeviceHash(zeros, invalid)).toBe(false);
  expect(isRegistrableDeviceHash(hash.toUpperCase(), invalid)).toBe(false);
  expect(isRegistrableDeviceHash(zeros, new Set())).toBe(true);
});

it('binds the install_secret context to the device row and keeps it a valid field-crypto context', () => {
  const id = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a60';
  const context = installSecretContext(id);
  expect(context).toBe(`devices.install_secret:${id}`);
  const otherDeviceId = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a61';
  expect(installSecretContext(otherDeviceId)).not.toBe(context);
  // platform/crypto: 1..200 printable ASCII characters (0x21..0x7e).
  expect(context.length).toBeLessThanOrEqual(200);
  expect(context).toMatch(/^[\x21-\x7e]+$/);
});
