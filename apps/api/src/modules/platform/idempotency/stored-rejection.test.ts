import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../clock/index.ts';
import { createIdempotency, type IdempotentRequest } from './index.ts';
import { registerIdempotencyPostMissCheck } from './post-miss.ts';
import { StoredRejection } from './stored-rejection.ts';

const actor = { userId: '0199a3b4-5c6d-7e8f-9a0b-000000000001', deviceId: null, phoneHmac: null };
const sensitive: IdempotentRequest = {
  appId: 'couli',
  actor,
  method: 'PUT',
  path: '/v1/me/payout-account',
  key: '0199a3b4-5c6d-7e8f-9a0b-0000000000aa',
  body: {},
  traceId: 'unit-trace',
};
const standard: IdempotentRequest = { ...sensitive, method: 'POST', path: '/v1/links/l/open' };
const refusal = { code: 30304, msg: '未实名', trace_id: 'unit-trace' };

// A scripted driver (as in failures.test.ts): Kysely's real transaction wrapper, no PG connection.
function fixture() {
  const statements: { text: string; params: readonly unknown[] }[] = [];
  const client = {
    release: vi.fn(),
    async query(text: string, params: readonly unknown[] = []) {
      statements.push({ text, params });
      let rows: unknown[] = [];
      if (text.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: true }];
      else if (text.includes('current_setting')) rows = [{ value: '0' }];
      else if (text.startsWith('insert'))
        rows = [{ id: 1n, created_at: new Date(), ownership_created_at: '2031-01-01T00:00:00Z' }];
      else if (text.startsWith('update')) rows = [{ id: 1n }];
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  const idem = createIdempotency({
    db,
    clock: new FixedClock('2031-01-01T00:00:00Z'),
    logger: { warn: vi.fn() },
  });
  const completed = () =>
    statements.filter((s) => s.text.startsWith('update') && s.params.includes('completed'));
  return { db, idem, statements, completed };
}

it('[BR-ID-01] StoredRejection accepts only codes 30000–39999', () => {
  for (const code of [0, 10005, 29999, 40000, 30304.5]) {
    expect(() => new StoredRejection(403, { code, msg: 'x', trace_id: 't' })).toThrow(TypeError);
  }
  const stored = new StoredRejection(422, refusal);
  expect(stored.result).toEqual({ status: 422, envelope: refusal });
  expect(stored).toBeInstanceOf(Error);
});

for (const mode of ['executeInTransaction', 'execute'] as const) {
  it(`[BR-ID-01] ${mode}: a StoredRejection from a post-miss check is stored as completed and returned; later checks and the handler do not run`, async () => {
    const f = fixture();
    try {
      const later = vi.fn(async () => undefined);
      registerIdempotencyPostMissCheck(f.idem, async () => {
        throw new StoredRejection(422, refusal);
      });
      registerIdempotencyPostMissCheck(f.idem, later);
      const handler = vi.fn(async () => ({
        status: 200,
        envelope: { code: 0, msg: '', trace_id: 'unit-trace' },
      }));
      const response =
        mode === 'execute'
          ? await f.idem.execute(standard, handler)
          : await f.idem.executeInTransaction(sensitive, handler);
      expect(response).toEqual({ status: 422, body: JSON.stringify(refusal), source: 'handler' });
      expect(handler).not.toHaveBeenCalled();
      expect(later).not.toHaveBeenCalled();
      const writes = f.completed();
      expect(writes).toHaveLength(1);
      expect(writes[0]!.params).toContainEqual({ status: 422, body: JSON.stringify(refusal) });
      expect(f.statements.some((s) => s.text === 'rollback')).toBe(false);
    } finally {
      await f.db.destroy();
    }
  });

  it(`[BR-ID-01] ${mode}: any other post-miss rejection still propagates unchanged and stores nothing`, async () => {
    const f = fixture();
    try {
      const error = Object.assign(new Error('phone required'), { code: 10005, statusCode: 403 });
      registerIdempotencyPostMissCheck(f.idem, async () => {
        throw error;
      });
      const handler = vi.fn(async () => ({
        status: 200,
        envelope: { code: 0, msg: '', trace_id: 'unit-trace' },
      }));
      const call =
        mode === 'execute'
          ? f.idem.execute(standard, handler)
          : f.idem.executeInTransaction(sensitive, handler);
      await expect(call).rejects.toBe(error);
      expect(handler).not.toHaveBeenCalled();
      expect(f.completed()).toHaveLength(0);
      expect(f.statements.some((s) => s.text.startsWith('insert'))).toBe(false);
      expect(f.statements.at(-1)?.text).toBe('rollback');
    } finally {
      await f.db.destroy();
    }
  });
}
