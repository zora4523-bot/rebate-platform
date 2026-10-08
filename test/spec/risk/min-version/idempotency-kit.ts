import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { vi } from 'vitest';
import {
  FixedClock,
  createIdempotency,
  requestHashOf,
  type IdempotentRequest,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { PRINCIPAL, TRACE } from './kit.ts';

export const STORED = '{"code":0,"msg":"original","data":{"ok":true},"trace_id":"original-trace"}';
export const RESULT = { status: 200, envelope: { code: 0, msg: '', trace_id: TRACE } };

export function idemRequest(transactional: boolean): IdempotentRequest {
  return {
    appId: 'couli',
    actor: { userId: PRINCIPAL.uid, deviceId: null, phoneHmac: null },
    method: 'POST',
    path: transactional ? '/v1/withdrawals' : '/v1/links/link-1/open',
    key: 'b103c-key',
    body: { item: 'fixture' },
    traceId: TRACE,
  };
}

/** Scripted PG wire driver, not a replacement idempotency implementation. Real Kysely and
 * createIdempotency execute their queries/transactions. No sockets, database or timers. */
export function idemFixture(
  input: IdempotentRequest,
  state: 'missing' | 'completed' | 'processing' | 'expired-processing' | 'abandoned' = 'missing',
  lockAcquired = true,
  minimum: string | null = null,
) {
  const events: string[] = [];
  const statements: string[] = [];
  const createdAt =
    state === 'expired-processing' ? '2030-12-31T23:58:00.000Z' : '2031-01-01T00:00:00.000Z';
  let row: Record<string, unknown> | undefined =
    state === 'missing'
      ? undefined
      : {
          id: '41',
          app_id: input.appId,
          subject: `u:${PRINCIPAL.uid}`,
          method: input.method,
          path: input.path,
          key: input.key,
          request_hash: requestHashOf(input.body),
          status: state === 'expired-processing' ? 'processing' : state,
          response: state === 'completed' ? { status: 201, body: STORED } : null,
          created_at: new Date(createdAt),
          ownership_created_at: createdAt,
        };
  let transactionRow: typeof row;
  const client = {
    release: vi.fn(),
    async query(text: string, parameters: readonly unknown[] = []) {
      statements.push(text);
      let rows: unknown[] = [];
      if (/^begin\b/i.test(text)) transactionRow = structuredClone(row);
      else if (/^rollback\b/i.test(text)) row = transactionRow;
      else if (text.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: lockAcquired }];
      else if (text.includes('current_setting')) rows = [{ value: '0' }];
      else if (/^select\b/i.test(text) && text.includes('app_versions')) {
        events.push('minimum-read');
        rows = [{ channel: 'app_store', min_supported_version: minimum }];
      } else if (/^select\b/i.test(text) && text.includes('idempotency_keys')) {
        events.push('lookup');
        rows = row === undefined ? [] : [row];
      } else if (/^insert\b/i.test(text)) {
        events.push('insert');
        row = {
          id: '42',
          status: 'processing',
          created_at: new Date('2031-01-01T00:00:00.000Z'),
          ownership_created_at: '2031-01-01T00:00:00.000Z',
        };
        rows = [row];
      } else if (/^update\b/i.test(text)) {
        events.push('update');
        // Apply bound SET values so a leaked takeover cannot pass an unchanged-row assertion.
        // WHERE values are deliberately excluded; transaction rollback restores the snapshot.
        const assignments = text.split(/\bset\b/i)[1]?.split(/\bwhere\b/i)[0] ?? '';
        if (row !== undefined) {
          for (const match of assignments.matchAll(/"(\w+)"\s*=\s*\$(\d+)/g)) {
            const column = match[1]!;
            const value = parameters[Number(match[2]) - 1];
            if (column === 'created_at') {
              row[column] = new Date(String(value));
              row['ownership_created_at'] = value;
            } else row[column] = value;
          }
          rows = [row];
        }
      } else if (/^delete\b/i.test(text)) {
        events.push('delete');
        row = undefined;
        rows = [{ id: '42' }];
      }
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
  const execute = (handler = async () => RESULT) =>
    input.path === '/v1/withdrawals'
      ? idem.executeInTransaction(input, handler)
      : idem.execute(input, handler);
  return { db, idem, events, statements, execute, storedRow: () => structuredClone(row) };
}
