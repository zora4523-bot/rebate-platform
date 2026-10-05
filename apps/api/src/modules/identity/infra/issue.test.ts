import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { INSTALL_SECRET_BYTES, newDeviceId, newInstallSecret } from './issue.ts';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it('[AC-B1-02c#1] issues lower-case UUIDv7 device ids carrying the clock time, distinct within one millisecond', () => {
  const now = new FixedClock('2026-10-05T04:00:00.123Z').now();
  const ids = Array.from({ length: 50 }, () => newDeviceId(now));
  for (const id of ids) {
    expect(id).toMatch(UUID_V7);
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(now.getTime());
  }
  expect(new Set(ids).size).toBe(ids.length);
});

it('refuses instants outside the UUIDv7 time range', () => {
  const clock = new FixedClock('1970-01-01T00:00:00.000Z');
  expect(newDeviceId(clock.now())).toMatch(/^00000000-0000-7/);
  clock.advanceMs(-1);
  expect(() => newDeviceId(clock.now())).toThrow(/UUIDv7/);
  clock.set('2026-10-05T04:00:00.000Z');
  clock.advanceMs(2 ** 48);
  expect(() => newDeviceId(clock.now())).toThrow(/UUIDv7/);
  expect(() => newDeviceId(new Date(Number.NaN))).toThrow(/UUIDv7/);
  expect(() => newDeviceId({} as Date)).toThrow(/UUIDv7/);
});

it('[AC-B1-02c#7] issues 256-bit install secrets as unpadded base64url within the contract length', () => {
  const secrets = Array.from({ length: 50 }, () => newInstallSecret());
  for (const secret of secrets) {
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(INSTALL_SECRET_BYTES);
    expect(secret.length).toBeGreaterThanOrEqual(16);
    expect(secret.length).toBeLessThanOrEqual(128);
  }
  expect(new Set(secrets).size).toBe(secrets.length);
});
