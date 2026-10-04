import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../clock/index.ts';
import { createIdempotency, type IdempotentRequest } from './index.ts';

const request: IdempotentRequest = {
  appId: 'couli',
  actor: { userId: '0199a3b4-5c6d-7e8f-9a0b-000000000001', deviceId: null, phoneHmac: null },
  method: 'POST',
  path: '/v1/withdrawals',
  key: 'unit-key',
  body: {},
  traceId: 'unit-trace',
};

// A scripted driver exercises Kysely's actual transaction wrapper without connecting to PG.
// Database concurrency and uniqueness are tested separately by the externally authored suite.
function fixture(failAt: 'record' | 'commit' | 'claim' | 'none') {
  const error = Object.assign(new Error('driver failure'), { code: '55P03' });
  const statements: string[] = [];
  const release = vi.fn();
  const client = {
    release,
    async query(text: string) {
      statements.push(text);
      if (
        (failAt === 'record' && text.startsWith('update')) ||
        (failAt === 'commit' && text === 'commit') ||
        (failAt === 'claim' && text.startsWith('insert'))
      )
        throw error;
      let rows: unknown[] = [];
      if (text.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: true }];
      else if (text.includes('current_setting')) rows = [{ value: '0' }];
      else if (text.startsWith('insert')) rows = [{ id: 1n }];
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
  return { db, idem, error, statements, release };
}

it('[AC-B1-01i#1] only a failed COMMIT is classified as outcome_unknown; record-write failures keep the driver error', async () => {
  for (const phase of ['record', 'commit'] as const) {
    const f = fixture(phase);
    try {
      const call = f.idem.executeInTransaction(request, async () => ({
        status: 200,
        envelope: { code: 0, msg: '', trace_id: 'unit-trace' },
      }));
      if (phase === 'commit') await expect(call).rejects.toMatchObject({ code: 'outcome_unknown' });
      else await expect(call).rejects.toBe(f.error);
      expect(f.statements.includes('commit')).toBe(phase === 'commit');
      expect(f.statements.at(-1)).toBe('rollback');
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {
      await f.db.destroy();
    }
  }
});

it('[AC-B1-01i#2] lock timeout becomes 40901 only during key acquisition; a handler lock failure remains its original error', async () => {
  for (const phase of ['claim', 'none'] as const) {
    const f = fixture(phase);
    const handler = vi.fn(async () => {
      throw f.error;
    });
    try {
      const call = f.idem.executeInTransaction(request, handler);
      if (phase === 'claim') {
        const response = await call;
        expect(JSON.parse(response.body)).toMatchObject({ code: 40901 });
        expect(handler).not.toHaveBeenCalled();
      } else {
        await expect(call).rejects.toBe(f.error);
        expect(handler).toHaveBeenCalledTimes(1);
      }
      expect(f.statements).not.toContain('commit');
      expect(f.statements.at(-1)).toBe('rollback');
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {
      await f.db.destroy();
    }
  }
});
