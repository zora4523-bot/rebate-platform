import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { connect } from '../linking-bindings/kit.ts';
import { TIMEOUT, requireShape } from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
}, TIMEOUT);

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
}, TIMEOUT);

// Catalog fallback until the trusted fixture exposes a role with full UPDATE/DELETE.
// Inspect the attached function, not an ACL failure or the trigger/function name.
// This is source evidence; it does not claim execution of the privileged branches.
it(
  '[AC-B1-06y#26] trigger bodies reject immutable-column rewrites and DELETE with 23001',
  async () => {
    await requireShape();
    const result = await sql<{
      update_event: boolean;
      delete_event: boolean;
      body: string;
    }>`
      SELECT (t.tgtype::integer & 16) <> 0 AS update_event,
        (t.tgtype::integer & 8) <> 0 AS delete_event, p.prosrc AS body
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = to_regclass('app.union_binding_conflicts')
        AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
        AND (t.tgtype::integer & 1) <> 0 AND t.tgqual IS NULL
    `.execute(app);
    const triggers = result.rows.map((trigger) => ({
      ...trigger,
      body: trigger.body.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, ''),
    }));
    const raisesRestriction =
      /\bRAISE\s+(?:EXCEPTION\b[^;]*\bERRCODE\s*=\s*'(?:23001|restrict_violation)'|SQLSTATE\s+'23001'|restrict_violation\b)/i;
    const updateGuards = triggers.filter(
      (trigger) => trigger.update_event && raisesRestriction.test(trigger.body),
    );
    expect(updateGuards.length, 'UPDATE guard must raise restrict_violation').toBeGreaterThan(0);
    for (const column of [
      'id',
      'app_id',
      'user_id',
      'platform',
      'union_account_id',
      'kind',
      'occurred_at',
    ]) {
      expect(
        updateGuards.some(({ body }) => {
          // Accept a whole-record comparison or explicit OLD/NEW immutable fields,
          // including the ROW(...) IS DISTINCT FROM ROW(...) style of 0018/0020.
          const wholeRecord =
            /\b(?:NEW\s+IS\s+DISTINCT\s+FROM\s+OLD|OLD\s+IS\s+DISTINCT\s+FROM\s+NEW)\b/i.test(body);
          const fields = ['OLD', 'NEW'].every((record) =>
            new RegExp(`\\b${record}\\s*\\.\\s*"?${column}"?\\b`, 'i').test(body),
          );
          return wholeRecord || (fields && /\bIS\s+DISTINCT\s+FROM\b|<>|!=/i.test(body));
        }),
        `UPDATE rejection must compare immutable ${column}`,
      ).toBe(true);
    }
    expect(
      triggers.some(({ update_event, delete_event, body }) => {
        if (!delete_event) return false;
        // A dedicated DELETE function may reject unconditionally. A shared function
        // must raise in its DELETE branch, not merely in the resolved-row branch.
        if (!update_event && /\bBEGIN\s+RAISE\b/i.test(body)) {
          return raisesRestriction.test(body);
        }
        const deleteBranch =
          /\b(?:IF|ELSIF)\s+\(?\s*(?:TG_OP\s*=\s*'DELETE'|'DELETE'\s*=\s*TG_OP)\s*\)?\s+THEN\s+(RAISE\b[^;]*);/i.exec(
            body,
          );
        return deleteBranch !== null && raisesRestriction.test(deleteBranch[1]!);
      }),
      'DELETE must raise 23001, not return OLD or rely on column grants',
    ).toBe(true);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#27] occurrence and resolution timestamps have no database defaults',
  async () => {
    await requireShape();
    const result = await sql<{ name: string; has_default: boolean }>`
      SELECT a.attname::text AS name, d.oid IS NOT NULL AS has_default
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass('app.union_binding_conflicts')
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname IN ('occurred_at', 'resolved_at')
      ORDER BY a.attname
    `.execute(app);
    // Absence of any default also excludes wrapped SQL clocks and clock aliases.
    expect(result.rows).toEqual([
      { name: 'occurred_at', has_default: false },
      { name: 'resolved_at', has_default: false },
    ]);
  },
  TIMEOUT,
);
