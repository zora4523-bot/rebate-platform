import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';

/** Only the wire storage of the real idempotency primitive is replaced. No sockets, SQL
 * server, favorites SQL or alternative replay algorithm. Sequential HTTP requests only. */
export function idempotencyStorage() {
  type Row = Record<string, unknown>;
  let records: Row[] = [];
  let snapshot: Row[] = [];
  let sequence = 0;
  const statements: string[] = [];
  const client = {
    release() {},
    async query(text: string, parameters: readonly unknown[] = []) {
      statements.push(text);
      let rows: Row[] = [];
      const where = text.split(/\bwhere\b/i)[1] ?? '';
      const matches = (row: Row) =>
        [...where.matchAll(/(?:"(\w+)"|\b(id))\s*=\s*\$(\d+)/g)].every(
          (match) => row[match[1] ?? match[2]!] === parameters[Number(match[3]) - 1],
        );
      if (/^begin\b/i.test(text)) snapshot = structuredClone(records);
      else if (/^rollback\b/i.test(text)) records = snapshot;
      else if (/^(commit|set transaction)\b/i.test(text)) rows = [];
      else if (text.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: true }];
      else if (text.includes('current_setting')) rows = [{ value: '0' }];
      else if (text.includes('set_config')) rows = [];
      else if (/^select\b/i.test(text) && text.includes('idempotency_keys')) {
        rows = records.filter(matches);
      } else if (/^insert\b/i.test(text) && text.includes('idempotency_keys')) {
        const columns = text.match(/\(([^)]+)\) values/i)?.[1]?.match(/"(\w+)"/g) ?? [];
        const values =
          text
            .split(/\bvalues\s*\(/i)[1]
            ?.split(')')[0]
            ?.split(',') ?? [];
        const row: Row = { id: String(++sequence) };
        for (const [index, column] of columns.entries()) {
          const binding = values[index]?.match(/\$(\d+)/);
          if (binding) row[column.replaceAll('"', '')] = parameters[Number(binding[1]) - 1];
        }
        row['ownership_created_at'] = row['created_at'];
        row['created_at'] = new Date(String(row['created_at']));
        records.push(row);
        rows = [row];
      } else if (/^update\b/i.test(text) && text.includes('idempotency_keys')) {
        rows = records.filter(matches);
        const set = text.split(/\bset\b/i)[1]?.split(/\bwhere\b/i)[0] ?? '';
        for (const row of rows) {
          for (const match of set.matchAll(/"(\w+)"\s*=\s*\$(\d+)/g)) {
            const value = parameters[Number(match[2]) - 1];
            row[match[1]!] =
              match[1] === 'response' && typeof value === 'string' ? JSON.parse(value) : value;
          }
        }
      } else if (/^delete\b/i.test(text) && text.includes('idempotency_keys')) {
        rows = records.filter(matches);
        records = records.filter((row) => !matches(row));
      } else {
        throw new Error(`favorites-route fixture: unexpected SQL: ${text}`);
      }
      return { command: 'SELECT', rowCount: rows.length, rows: structuredClone(rows) };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  return { db, statements };
}
