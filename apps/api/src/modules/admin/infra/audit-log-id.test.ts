import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createAuditLogIdCodec, keyringAuditLogIdKey } from './audit-log-id.ts';

const codec = createAuditLogIdCodec(Buffer.alloc(16, 7));

it('[AC-B1-34a] ids round-trip, match the contract pattern and do not show the key', () => {
  for (const id of [1n, 2n, 9007199254740992n, 9007199254740993n, (1n << 63n) - 1n]) {
    const wire = codec.encode(id);
    expect(wire).toMatch(/^aud_[A-Za-z0-9_-]{22}$/);
    // Short decimal strings occur in any base64 text by chance; only long ones are meaningful.
    if (id > 1_000_000n) expect(wire).not.toContain(String(id));
    const payload = Buffer.from(wire.slice(4), 'base64url');
    const raw = Buffer.alloc(8);
    raw.writeBigUInt64BE(id);
    expect(payload.includes(raw)).toBe(false);
    expect(codec.decode(wire)).toBe(id);
    expect(codec.encode(id)).toBe(wire);
  }
  expect(codec.encode(9007199254740992n)).not.toBe(codec.encode(9007199254740993n));
});

it('[AC-B1-34a] altered, malformed, non-canonical and foreign values do not decode', () => {
  const wire = codec.encode(42n);
  const altered = `${wire.slice(0, 4)}${wire[4] === 'A' ? 'B' : 'A'}${wire.slice(5)}`;
  const last = wire.at(-1)!;
  const sibling = `${wire.slice(0, -1)}${last === 'A' ? 'B' : String.fromCharCode(last.charCodeAt(0) ^ 1)}`;
  for (const value of [
    altered,
    sibling,
    'x',
    '42',
    `aud_${'A'.repeat(22)}`,
    `aud_${'A'.repeat(61)}`,
    'aud_!!!!!!!!!!!!!!!!!!!!!!',
    wire.slice(4),
  ]) {
    expect(codec.decode(value)).toBeUndefined();
  }
  expect(createAuditLogIdCodec(Buffer.alloc(16, 8)).decode(wire)).toBeUndefined();
  expect(() => codec.encode(0n)).toThrow(RangeError);
  expect(() => codec.encode(1n << 63n)).toThrow(RangeError);
  expect(() => createAuditLogIdCodec(randomBytes(15))).toThrow(TypeError);
});

it('[AC-B1-34a] the key is the keyring blind index of a fixed label under audit-log-id', () => {
  const calls: [string, string][] = [];
  const key = keyringAuditLogIdKey({
    blindIndex: (value, context) => {
      calls.push([value, context]);
      return 'ab'.repeat(32);
    },
  });
  expect(calls).toEqual([['couli.admin.audit_log_id.v1', 'audit-log-id']]);
  expect(key).toEqual(Buffer.alloc(16, 0xab));
});
