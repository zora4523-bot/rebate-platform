import { scryptSync } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  generateAdminTotpSecret,
  hashAdminPassword,
  verifyAdminPassword,
} from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import { PASSWORD } from './fixture.ts';

it('[AC-F1-06c-BOOTSTRAP#13] production password hashes have fresh salts and a verifiable versioned scrypt format', async () => {
  const hashes = [await hashAdminPassword(PASSWORD), await hashAdminPassword(PASSWORD)];
  expect(hashes[0]).not.toBe(hashes[1]);
  const salts: string[] = [];
  for (const hash of hashes) {
    expect(hash).not.toContain(PASSWORD);
    expect(hash).toMatch(/^scrypt\$v=1\$N=131072\$r=8\$p=1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    const [, , , , , salt, key] = hash.split('$');
    salts.push(salt!);
    // Independent derivation detects fast hashes disguised by a scrypt-looking prefix.
    const expected = scryptSync(PASSWORD, Buffer.from(salt!, 'hex'), 64, {
      N: 131072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
    expect(key).toBe(expected.toString('hex'));
    expect(await verifyAdminPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyAdminPassword(`${PASSWORD}!`, hash)).toBe(false);
  }
  expect(salts[0]).not.toBe(salts[1]);
}, 20_000);

it('[AC-F1-06c-BOOTSTRAP#14] the production password verifier rejects malformed stored values', async () => {
  // NotImplemented must escape rather than be swallowed as an expected rejection.
  for (const encoded of ['', PASSWORD, 'scrypt$v=1$N=131072$r=8$p=1$00$00']) {
    expect(await verifyAdminPassword(PASSWORD, encoded)).toBe(false);
  }
});

it('[AC-F1-06c-BOOTSTRAP#15] the production binding generator returns distinct secrets of at least 20 bytes', () => {
  const first = generateAdminTotpSecret();
  const saved = Buffer.from(first);
  const second = generateAdminTotpSecret();
  expect(first).toBeInstanceOf(Uint8Array);
  expect(second).toBeInstanceOf(Uint8Array);
  expect(first.byteLength).toBeGreaterThanOrEqual(20);
  expect(second.byteLength).toBeGreaterThanOrEqual(20);
  expect(Buffer.from(first)).toEqual(saved);
  expect(Buffer.from(second)).not.toEqual(saved);
});
