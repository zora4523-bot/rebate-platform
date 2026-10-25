// Unit tests of the App's own copies (B1-27i) on a scripted pg transport: real Kysely statements,
// no database, no listen. The rule tests (test/spec/identity/data-copies-download) cover the
// behaviour against PostgreSQL; these pin the deletion stage read from users.status alone.
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it } from 'vitest';
import {
  FixedClock,
  MemoryExportStore,
  createRootLogger,
  dataCopyObjectKey,
} from '../../platform/index.ts';
import { createMyDataCopies } from './my-data-copies.ts';

const APP = 'b1_27i_unit';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const COPY = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d01';
const NOW = '2026-11-03T02:20:00.000Z';
const HOUR = 3_600_000;

function fixture(userStatus: string) {
  const clock = new FixedClock(NOW);
  const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
  const store = new MemoryExportStore({
    baseUrl: 'https://exports.invalid',
    signingKey: 'unit-test-only-signing-key',
    clock,
    logger,
  });
  const now = clock.now().getTime();
  const copy = {
    id: COPY,
    status: 'delivered',
    object_key: dataCopyObjectKey(APP, COPY, 'seed'),
    generated_at: new Date(now - HOUR),
    expires_at: new Date(now + 23 * HOUR),
  };
  const statements: string[] = [];
  const client = {
    release() {},
    async query(text: string) {
      statements.push(text);
      if (text.includes('deletion_requests')) {
        return {
          command: 'SELECT',
          rowCount: 1,
          rows: [{ id: USER, status: userStatus, request_status: null }],
        };
      }
      if (text.includes('personal_data_copies')) {
        return { command: 'SELECT', rowCount: 1, rows: [copy] };
      }
      return { command: 'SELECT', rowCount: 0, rows: [] };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  const service = createMyDataCopies({ db, clock, store });
  const reads = () => statements.filter((text) => text.includes('personal_data_copies'));
  return { service, reads, copy, now };
}

const SUBJECT = { appId: APP, userId: USER };

it('[B1-27i] an active account lists and downloads its copy; the link ends 5 minutes on', async () => {
  const f = fixture('active');
  expect(await f.service.list(SUBJECT)).toEqual([
    {
      copyId: COPY,
      status: 'delivered',
      generatedAt: f.copy.generated_at,
      expiresAt: f.copy.expires_at,
    },
  ]);
  const link = await f.service.download(SUBJECT, COPY);
  expect(link.kind).toBe('link');
  if (link.kind === 'link') expect(link.urlExpiresAt.getTime()).toBe(f.now + 300_000);
});

it.each(['deleting', 'deleted'])(
  '[B1-27i] users.status %s alone empties the list and refuses every download',
  async (status) => {
    const f = fixture(status);
    expect(await f.service.list(SUBJECT)).toEqual([]);
    expect(await f.service.download(SUBJECT, COPY)).toEqual({ kind: 'not_found' });
    expect(f.reads()).toEqual([]);
  },
);

it('[B1-27i] an id that is not a UUID is not_found without a read', async () => {
  const f = fixture('active');
  expect(await f.service.download(SUBJECT, 'not-a-copy')).toEqual({ kind: 'not_found' });
  expect(f.reads()).toEqual([]);
});
