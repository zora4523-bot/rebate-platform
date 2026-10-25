// Unit tests of the data-copy expire job (B1-27i) on a scripted pg transport: real Kysely
// statements, no database, no listen. They pin the clean-up after a first wecom_session download
// (the delivery file and the sealed file it names both deleted) and an in_app_sms file without a
// sealed file.
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it } from 'vitest';
import {
  FixedClock,
  MemoryExportStore,
  createRootLogger,
  dataCopyObjectKey,
  type FieldCrypto,
} from '../../platform/index.ts';
import { dataCopyDeliveryKey, dataCopySealedKeyOf } from '../infra/personal-data-copies.ts';
import { DATA_COPY_EXPIRE_JOB, DATA_COPY_QUEUE, createDataCopyWorker } from './data-copy-worker.ts';

const APP = 'b1_27i_unit';
const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const COPY = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d01';
const NOW = '2026-11-04T03:00:00.000Z';
const HOUR = 3_600_000;

const unused = (): never => {
  throw new Error('not used by the expire job');
};

function fixture(delivery: 'wecom_session' | 'in_app_sms', objectKey: string, status: string) {
  const clock = new FixedClock(NOW);
  const logger = createRootLogger({ level: 'silent', entry: 'worker', appEnv: 'test' });
  const store = new MemoryExportStore({
    baseUrl: 'https://exports.invalid',
    signingKey: 'unit-test-only-signing-key',
    clock,
    logger,
  });
  const now = clock.now().getTime();
  const row = {
    id: COPY,
    app_id: APP,
    user_id: USER,
    requested_by: delivery === 'wecom_session' ? ADMIN : null,
    delivery,
    status,
    retry_of: null,
    object_key: objectKey,
    due_at: new Date(now + 216 * HOUR),
    generated_at: new Date(now - 24 * HOUR),
    delivered_at: status === 'delivered' ? new Date(now - 20 * HOUR) : null,
    expires_at: new Date(now - 1),
    failure_reason: null,
    row_version: 4,
    created_at: new Date(now - 48 * HOUR),
    updated_at: new Date(now - 20 * HOUR),
  };
  const updates: { text: string; values: readonly unknown[] }[] = [];
  const client = {
    release() {},
    async query(text: string, values: readonly unknown[] = []) {
      if (/^update\b/i.test(text)) {
        updates.push({ text, values });
        return { command: 'UPDATE', rowCount: 1, rows: [] };
      }
      if (/^select\b/i.test(text) && text.includes('personal_data_copies')) {
        return { command: 'SELECT', rowCount: 1, rows: [row] };
      }
      return { command: 'SELECT', rowCount: 0, rows: [] };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  const sent: string[] = [];
  const worker = createDataCopyWorker({
    db,
    clock,
    queue: {
      send: async (_queue, name) => {
        sent.push(name);
        return null;
      },
    },
    store,
    sources: unused as never,
    crypto: unused as unknown as FieldCrypto,
    sms: { send: unused } as never,
    inbox: { record: unused, dispatch: unused },
    auditWriter: () => ({ append: unused }),
    logger,
  });
  const expireJob = {
    id: 'job-expire-1',
    queue: DATA_COPY_QUEUE,
    name: DATA_COPY_EXPIRE_JOB,
    payload: { appId: APP, copyId: COPY },
    attempt: 1,
  };
  return { store, updates, sent, worker, expireJob };
}

/** The SET of the one update: object_key and status as bound parameters. */
function updatedColumns(update: { text: string; values: readonly unknown[] }) {
  const set = /\bset\s+(.*?)\s+where\b/is.exec(update.text)![1]!;
  const columns: Record<string, unknown> = {};
  for (const part of set.split(',')) {
    const match = /"(\w+)"\s*=\s*\$(\d+)/.exec(part);
    if (match !== null) columns[match[1]!] = update.values[Number(match[2]) - 1];
  }
  return columns;
}

it('[B1-27i] expire after a first wecom_session download deletes the delivery file and its sealed file', async () => {
  const sealedKey = dataCopyObjectKey(APP, COPY, 'sealedrun');
  const deliveryKey = dataCopyDeliveryKey(sealedKey);
  expect(dataCopySealedKeyOf(deliveryKey)).toBe(sealedKey);
  const f = fixture('wecom_session', deliveryKey, 'delivered');
  const bytes = new TextEncoder().encode('unit copy\n');
  await f.store.put({ key: sealedKey, bytes, contentType: 'application/octet-stream' });
  await f.store.put({ key: deliveryKey, bytes, contentType: 'application/zip' });

  await f.worker.handle(f.expireJob);

  expect(f.store.get(deliveryKey)).toBeUndefined();
  expect(f.store.get(sealedKey)).toBeUndefined();
  expect(f.updates).toHaveLength(1);
  expect(updatedColumns(f.updates[0]!)).toMatchObject({ object_key: null, status: 'expired' });
  expect(f.sent).toEqual([]);
});

it('[B1-27i] expire of an in_app_sms copy (no sealed file) deletes the ZIP and clears object_key', async () => {
  const zipKey = dataCopyObjectKey(APP, COPY, 'smsrun');
  expect(dataCopySealedKeyOf(zipKey)).toBeNull();
  const f = fixture('in_app_sms', zipKey, 'delivered');
  await f.store.put({
    key: zipKey,
    bytes: new TextEncoder().encode('zip\n'),
    contentType: 'application/zip',
  });

  await expect(f.worker.handle(f.expireJob)).resolves.toBeUndefined();

  expect(f.store.get(zipKey)).toBeUndefined();
  expect(f.updates).toHaveLength(1);
  expect(updatedColumns(f.updates[0]!)).toMatchObject({ object_key: null, status: 'expired' });
});
