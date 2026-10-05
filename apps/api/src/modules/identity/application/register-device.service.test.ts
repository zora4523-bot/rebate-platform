import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, type FieldCrypto } from '../../platform/index.ts';
import { DevicesRepository } from '../infra/devices.repository.ts';
import { RegisterDeviceService, type RegisterDeviceCommand } from './register-device.service.ts';

const NOW = '2026-10-05T04:00:00.000Z';
const hash = createHash('sha256').update('9774d56d682e549d').digest('hex');
const zeros = createHash('sha256').update('0').digest('hex');
const command: RegisterDeviceCommand = {
  appId: 'couli',
  platform: 'android',
  appVersion: '2.3.4',
  deviceHash: hash,
  idSource: 'android_id',
};

/** Records `insertInto(table).values(row).execute()`, the only statement the repository runs. */
function fakeDb() {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const db = {
    insertInto: (table: string) => ({
      values: (row: Record<string, unknown>) => ({
        execute: async () => {
          inserts.push({ table, row });
          return [];
        },
      }),
    }),
  } as unknown as Kysely<DB>;
  return { db, inserts };
}

/** Stand-in cipher: records its calls; the output never contains the plaintext. */
function fakeCrypto() {
  const calls: { plaintext: string; context: string; ciphertext: string }[] = [];
  const unused = (): never => {
    throw new Error('not used by device registration');
  };
  const crypto: FieldCrypto = {
    currentKeyVersion: 1,
    encrypt(plaintext, context) {
      const digest = createHash('sha256').update(`${context}\0${plaintext}`).digest('base64url');
      const ciphertext = `v1.1.${digest}`;
      calls.push({ plaintext, context, ciphertext });
      return ciphertext;
    },
    decrypt: unused,
    keyVersionOf: unused,
    needsReencrypt: unused,
    reencrypt: unused,
    blindIndex: unused,
  };
  return { crypto, calls };
}

function service(options: { db?: Kysely<DB> | undefined; crypto?: FieldCrypto | undefined }) {
  return new RegisterDeviceService(
    new FixedClock(NOW),
    new Set([zeros]),
    new DevicesRepository(options.db),
    options.crypto,
  );
}

it('[AC-B1-02c#2][AC-B1-02c#3] stores one unbound row whose cipher is the field encryption of the returned secret', async () => {
  const { db, inserts } = fakeDb();
  const { crypto, calls } = fakeCrypto();
  const result = await service({ db, crypto }).register(command);
  if (result.kind !== 'registered') throw new Error('expected a registration');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    plaintext: result.installSecret,
    context: `devices.install_secret:${result.deviceId}`,
  });
  expect(inserts).toHaveLength(1);
  expect(inserts[0]!.table).toBe('devices');
  const now = new FixedClock(NOW).now();
  expect(inserts[0]!.row).toEqual({
    id: result.deviceId,
    app_id: 'couli',
    user_id: null,
    device_hash: hash,
    id_source: 'android_id',
    platform: 'android',
    app_version: '2.3.4',
    install_secret_cipher: Buffer.from(calls[0]!.ciphertext, 'utf8'),
    last_login_sid: null,
    revoked_at: null,
    last_seen_at: now,
    created_at: now,
    updated_at: now,
  });
  const stored = inserts[0]!.row['install_secret_cipher'] as Buffer;
  expect(stored.includes(Buffer.from(result.installSecret))).toBe(false);
  expect(stored.includes(Buffer.from(result.installSecret, 'base64url'))).toBe(false);
});

it('[AC-B1-02c#7] issues a new device id and secret on every registration of the same hash', async () => {
  const { db, inserts } = fakeDb();
  const registration = service({ db, crypto: fakeCrypto().crypto });
  const first = await registration.register(command);
  const second = await registration.register(command);
  if (first.kind !== 'registered' || second.kind !== 'registered') throw new Error('expected two');
  expect(second.deviceId).not.toBe(first.deviceId);
  expect(second.installSecret).not.toBe(first.installSecret);
  expect(inserts.map(({ row }) => row['device_hash'])).toEqual([hash, hash]);
  expect(inserts.map(({ row }) => row['revoked_at'])).toEqual([null, null]);
});

it('[AC-B1-02c#5] refuses a hash on the invalid list without encrypting or storing anything', async () => {
  const { db, inserts } = fakeDb();
  const { crypto, calls } = fakeCrypto();
  const result = await service({ db, crypto }).register({ ...command, deviceHash: zeros });
  expect(result).toEqual({ kind: 'invalid_device_hash' });
  expect(calls).toEqual([]);
  expect(inserts).toEqual([]);
});

it('fails the request, storing nothing, when the process has no keyring or no database', async () => {
  const { db, inserts } = fakeDb();
  await expect(service({ db }).register(command)).rejects.toThrow(/keyring/);
  expect(inserts).toEqual([]);
  await expect(service({ crypto: fakeCrypto().crypto }).register(command)).rejects.toThrow(
    /database/,
  );
  // An invalid hash is still refused without them.
  expect(await service({}).register({ ...command, deviceHash: zeros })).toEqual({
    kind: 'invalid_device_hash',
  });
});
