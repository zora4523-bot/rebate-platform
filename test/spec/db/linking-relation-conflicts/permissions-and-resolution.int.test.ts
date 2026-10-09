import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { columns, connect, sqlState } from '../linking-bindings/kit.ts';
import {
  LATER,
  OCCURRED,
  RESOLVED,
  TABLE,
  TIMEOUT,
  accepted,
  requireShape,
  stored,
} from './kit.ts';

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

it(
  '[AC-B1-06y#16] couli_app can SELECT and INSERT but can UPDATE only the two resolution columns',
  async () => {
    await requireShape();
    for (const { name } of await columns(TABLE)) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
        const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
        'couli_app', 'app.union_binding_conflicts', ${name}, ${privilege}
      ) AS allowed`.execute(app);
        expect(result.rows[0]?.allowed, `${name} ${privilege}`).toBe(
          privilege !== 'UPDATE' || ['resolved_at', 'resolution'].includes(name),
        );
      }
    }
    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      const result = await sql<{ allowed: boolean }>`SELECT has_table_privilege(
      'couli_app', 'app.union_binding_conflicts', ${privilege}
    ) AS allowed`.execute(app);
      expect(result.rows[0]?.allowed, privilege).toBe(false);
    }
    const row = await accepted(app);
    expect(await stored(app, row.id)).toEqual([expect.objectContaining(row)]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#17] updates to every non-resolution column fail with insufficient privilege',
  async () => {
    await requireShape();
    for (const state of [
      { resolved_at: null, resolution: null },
      { resolved_at: RESOLVED, resolution: 'bound_active' },
    ]) {
      const row = await accepted(app, state);
      const original = await stored(app, row.id);
      for (const { name } of await columns(TABLE)) {
        if (['resolved_at', 'resolution'].includes(name)) continue;
        expect(
          await sqlState(
            sql`UPDATE app.union_binding_conflicts
        SET ${sql.ref(name)} = ${sql.ref(name)} WHERE id = ${row.id}`.execute(app),
          ),
          name,
        ).toBe('42501');
        expect(await stored(app, row.id)).toEqual(original);
      }
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#18] DELETE fails with insufficient privilege for unresolved and resolved logs',
  async () => {
    await requireShape();
    for (const state of [
      { resolved_at: null, resolution: null },
      { resolved_at: RESOLVED, resolution: 'bound_active' },
      { resolved_at: OCCURRED, resolution: 'already_active' },
    ]) {
      const row = await accepted(app, state);
      const original = await stored(app, row.id);
      expect(
        await sqlState(
          sql`DELETE FROM app.union_binding_conflicts WHERE id = ${row.id}`.execute(app),
        ),
      ).toBe('42501');
      expect(await stored(app, row.id)).toEqual(original);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#19] unresolved logs accept a single resolution while preserving occurrence data',
  async () => {
    await requireShape();
    for (const resolved_at of [OCCURRED, RESOLVED]) {
      const row = await accepted(app);
      const original = (await stored(app, row.id))[0]!;
      expect(
        await sqlState(
          sql`UPDATE app.union_binding_conflicts
      SET resolved_at = ${resolved_at}, resolution = 'bound_active' WHERE id = ${row.id}`.execute(
            app,
          ),
        ),
      ).toBe('no error');
      expect(await stored(app, row.id)).toEqual([
        { ...original, resolved_at, resolution: 'bound_active' },
      ]);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#20] invalid partial or backwards resolutions cannot be introduced by UPDATE',
  async () => {
    await requireShape();
    const row = await accepted(app);
    const original = await stored(app, row.id);
    for (const change of [
      sql`resolved_at = ${RESOLVED}`,
      sql`resolution = 'bound_active'`,
      sql`resolved_at = ${RESOLVED}, resolution = 'manual'`,
      sql`resolved_at = ${new Date('2026-10-09T00:59:59.999Z')}, resolution = 'bound_active'`,
    ]) {
      expect(
        await sqlState(
          sql`UPDATE app.union_binding_conflicts SET ${change}
      WHERE id = ${row.id}`.execute(app),
        ),
      ).toBe('23514');
      expect(await stored(app, row.id)).toEqual(original);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#21] both resolution kinds reject reopening or rewriting with restrict_violation',
  async () => {
    await requireShape();
    for (const resolution of ['bound_active', 'already_active']) {
      const row = await accepted(app, { resolved_at: OCCURRED, resolution });
      const original = await stored(app, row.id);
      for (const change of [
        sql`resolved_at = NULL, resolution = NULL`,
        sql`resolved_at = ${LATER}`,
        sql`resolution = ${resolution === 'bound_active' ? 'already_active' : 'bound_active'}`,
        sql`resolved_at = NULL`,
        sql`resolution = NULL`,
      ]) {
        expect(
          await sqlState(
            sql`UPDATE app.union_binding_conflicts SET ${change}
        WHERE id = ${row.id}`.execute(app),
          ),
        ).toBe('23001');
        expect(await stored(app, row.id)).toEqual(original);
      }
    }
    // Cover a row resolved through UPDATE as well as rows inserted already resolved.
    const row = await accepted(app);
    expect(
      await sqlState(
        sql`UPDATE app.union_binding_conflicts
    SET resolved_at = ${RESOLVED}, resolution = 'bound_active' WHERE id = ${row.id}`.execute(app),
      ),
    ).toBe('no error');
    const original = await stored(app, row.id);
    expect(
      await sqlState(
        sql`UPDATE app.union_binding_conflicts
    SET resolved_at = NULL, resolution = NULL WHERE id = ${row.id}`.execute(app),
      ),
    ).toBe('23001');
    expect(await stored(app, row.id)).toEqual(original);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#22] enabled row triggers guard UPDATE and DELETE independently of column grants',
  async () => {
    await requireShape();
    const triggers = await sql<{ update_event: boolean; delete_event: boolean }>`
    SELECT (t.tgtype::integer & 16) <> 0 AS update_event,
      (t.tgtype::integer & 8) <> 0 AS delete_event
    FROM pg_trigger t WHERE t.tgrelid = to_regclass('app.union_binding_conflicts')
      AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
      AND (t.tgtype::integer & 1) <> 0
  `.execute(app);
    expect(triggers.rows.some((trigger) => trigger.update_event)).toBe(true);
    expect(triggers.rows.some((trigger) => trigger.delete_event)).toBe(true);
  },
  TIMEOUT,
);

// TODO(规划/11 §4.3): Probe immutable-column rewrites and DELETE with a role granted
// full UPDATE/DELETE, expecting 23001 — blocked on the trusted harness exposing that role.
// AC#22 checks registration only; ACL failures do not prove these trigger branches execute.
