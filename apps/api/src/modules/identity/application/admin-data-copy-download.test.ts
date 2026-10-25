// Unit tests of the console download of a wecom_session copy (B1-27i) on a scripted pg transport:
// real Kysely statements, no database, no listen. The rule tests (test/spec/identity/
// data-copies-download) cover the behaviour against PostgreSQL; these pin the choices they leave
// open: regenerate on a ready request, the deletion stage from users.status, the delivery file's
// key and the clean-up of a file whose transaction failed.
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it } from 'vitest';
import {
  FixedClock,
  MemoryExportStore,
  createRootLogger,
  dataCopyObjectKey,
  type AuditInput,
  type FieldCrypto,
} from '../../platform/index.ts';
import {
  createDataCopyFileReader,
  dataCopyDeliveryKey,
  dataCopySealedKeyOf,
} from '../infra/personal-data-copies.ts';
import {
  DATA_COPY_AUDIT_DOWNLOAD,
  createAdminDataCopyDownload,
  dataCopyLinkExpiry,
} from './admin-data-copy-download.ts';
import { sealDataCopyEntries } from './data-copy-file.ts';

const APP = 'b1_27i_unit';
const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const COPY = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d01';
const NOW = '2026-11-03T02:20:00.000Z';
const HOUR = 3_600_000;

/** A reversible stand-in of the field cipher (never a real key). */
const CRYPTO = {
  encrypt: (plain: string) => `unit:${plain}`,
  decrypt: (text: string) => text.slice('unit:'.length),
} as unknown as FieldCrypto;

function fixture(options: { status?: string; userStatus?: string; failAudit?: boolean } = {}) {
  const clock = new FixedClock(NOW);
  const logger = createRootLogger({ level: 'silent', entry: 'admin', appEnv: 'test' });
  const store = new MemoryExportStore({
    baseUrl: 'https://exports.invalid',
    signingKey: 'unit-test-only-signing-key',
    clock,
    logger,
  });
  const sealedKey = dataCopyObjectKey(APP, COPY, 'sealed');
  const now = clock.now().getTime();
  const row = {
    id: COPY,
    app_id: APP,
    user_id: USER,
    requested_by: ADMIN,
    delivery: 'wecom_session',
    status: options.status ?? 'ready',
    retry_of: null,
    object_key: sealedKey,
    due_at: new Date(now + 240 * HOUR),
    generated_at: new Date(now - HOUR),
    delivered_at: null,
    expires_at: new Date(now + 23 * HOUR),
    failure_reason: null,
    row_version: 3,
    created_at: new Date(now - 48 * HOUR),
    updated_at: new Date(now - HOUR),
  };
  const statements: string[] = [];
  const client = {
    release() {},
    async query(text: string) {
      statements.push(text);
      if (/^update\b/i.test(text)) return { command: 'UPDATE', rowCount: 1, rows: [] };
      if (/^select\b/i.test(text) && text.includes('personal_data_copies')) {
        return { command: 'SELECT', rowCount: 1, rows: [row] };
      }
      if (/^select\b/i.test(text) && text.includes('deletion_requests')) {
        const rows = [{ id: USER, status: options.userStatus ?? 'active', request_status: null }];
        return { command: 'SELECT', rowCount: 1, rows };
      }
      if (/^select\b/i.test(text) && text.includes('users')) {
        return { command: 'SELECT', rowCount: 1, rows: [{ id: USER }] };
      }
      return { command: 'SELECT', rowCount: 0, rows: [] };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  const audits: AuditInput[] = [];
  const service = createAdminDataCopyDownload({
    db,
    clock,
    logger,
    store,
    files: createDataCopyFileReader(store),
    crypto: CRYPTO,
    registrants: { canDownload: async () => true, names: async () => new Map() },
    auditOn: () => ({
      append: async (input) => {
        if (options.failAudit === true && input.action === DATA_COPY_AUDIT_DOWNLOAD) {
          throw new Error('synthetic audit failure');
        }
        audits.push(input);
      },
    }),
  });
  const entries = [{ name: 'README.txt', bytes: new TextEncoder().encode('unit copy\n') }];
  return { db, store, row, sealedKey, statements, audits, service, entries };
}

const input = (regenerate: boolean) => ({
  appId: APP,
  adminId: ADMIN,
  userId: USER,
  exportId: COPY,
  regenerate,
  ip: null,
});

it('[B1-27i] a delivery key names its sealed file; a delivery key is not a sealed one', () => {
  const sealed = dataCopyObjectKey(APP, COPY, 'Ab_c-12');
  const first = dataCopyDeliveryKey(sealed);
  const second = dataCopyDeliveryKey(sealed);
  expect(first).not.toBe(second);
  expect(dataCopySealedKeyOf(first)).toBe(sealed);
  expect(dataCopySealedKeyOf(sealed)).toBeNull();
  expect(() => dataCopyDeliveryKey(first)).toThrow(TypeError);
});

it('[B1-27i] the link ends at min(5 minutes, expires_at)', () => {
  const now = new Date(NOW);
  expect(dataCopyLinkExpiry(now, new Date(now.getTime() + HOUR)).getTime()).toBe(
    now.getTime() + 300_000,
  );
  expect(dataCopyLinkExpiry(now, new Date(now.getTime() + 1)).getTime()).toBe(now.getTime() + 1);
});

it('[B1-27i] regenerate on a ready request is the first download: a password, the delivery recorded', async () => {
  const f = fixture();
  await f.store.put({
    key: f.sealedKey,
    bytes: sealDataCopyEntries(f.entries, CRYPTO),
    contentType: 'application/octet-stream',
  });
  const result = await f.service.download(input(true));
  expect(result.kind).toBe('link');
  if (result.kind !== 'link') return;
  expect(typeof result.password).toBe('string');
  expect(f.audits.map((entry) => entry.action)).toEqual([
    'user_data_copy_deliver',
    DATA_COPY_AUDIT_DOWNLOAD,
  ]);
  expect(f.statements.some((text) => /^update\b/i.test(text))).toBe(true);
  // The sealed file stays for a later regenerate.
  expect(f.store.get(f.sealedKey)).toBeDefined();
  expect(JSON.stringify(f.audits)).not.toContain(result.password!);
});

it.each(['deleting', 'deleted'])(
  '[B1-27i] users.status %s (deletion processing / done) → 30417 cancelled, no file',
  async (userStatus) => {
    const f = fixture({ userStatus });
    await f.store.put({
      key: f.sealedKey,
      bytes: sealDataCopyEntries(f.entries, CRYPTO),
      contentType: 'application/octet-stream',
    });
    for (const regenerate of [false, true]) {
      expect(await f.service.download(input(regenerate))).toEqual({
        kind: 'not_downloadable',
        status: 'cancelled',
      });
    }
    expect(f.audits).toEqual([]);
    expect(f.statements.some((text) => /^update\b/i.test(text))).toBe(false);
  },
);

it('[B1-27i] a failing download audit rejects and deletes the file this call put', async () => {
  const f = fixture({ failAudit: true });
  await f.store.put({
    key: f.sealedKey,
    bytes: sealDataCopyEntries(f.entries, CRYPTO),
    contentType: 'application/octet-stream',
  });
  const put: string[] = [];
  const original = f.store.put.bind(f.store);
  f.store.put = async (file) => {
    put.push(file.key);
    await original(file);
  };
  await expect(f.service.download(input(false))).rejects.toThrow('synthetic audit failure');
  expect(put).toHaveLength(1);
  expect(f.store.get(put[0]!)).toBeUndefined();
  expect(f.store.get(f.sealedKey)).toBeDefined();
});
