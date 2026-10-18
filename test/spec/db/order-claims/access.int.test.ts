import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { columns } from './catalog.ts';
import {
  LATER,
  TABLES,
  admin,
  claim,
  decided,
  insert,
  item,
  ready,
  sqlState,
  update,
  useHarness,
} from './kit.ts';

const h = useHarness();
const MUTABLE = {
  claims: ['evidence_level', 'status', 'handler_admin_id', 'reason', 'row_version', 'updated_at'],
  claim_items: [
    'evidence',
    'evidence_link_log_ids',
    'decision',
    'reject_reason',
    'decided_by',
    'decided_at',
    'row_version',
    'updated_at',
  ],
};

it('[AC-B1-10a#28] effective table and column privileges match the complete two-role matrix', async () => {
  await ready(h.app);
  for (const table of TABLES) {
    for (const role of ['couli_app', 'couli_readonly']) {
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ]) {
        const allowed = privilege === 'SELECT' || (role === 'couli_app' && privilege === 'INSERT');
        const result = await sql<{ allowed: boolean }>`SELECT has_table_privilege(
          ${role}, ${`app.${table}`}, ${privilege}) AS allowed`.execute(h.app);
        expect(result.rows, `${table}/${role}/${privilege}`).toEqual([{ allowed }]);
      }
      for (const column of await columns(h.app, table)) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const allowed =
            privilege === 'SELECT' ||
            (role === 'couli_app' &&
              (privilege === 'INSERT' ||
                (privilege === 'UPDATE' && MUTABLE[table].includes(column.name))));
          const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
            ${role}, ${`app.${table}`}, ${column.name}, ${privilege}) AS allowed`.execute(h.app);
          expect(result.rows, `${table}.${column.name}/${role}/${privilege}`).toEqual([
            { allowed },
          ]);
        }
      }
    }
  }
});

it('[AC-B1-10a#29] populated tables deny immutable-column updates, deletion and readonly writes', async () => {
  await ready(h.app);
  for (const table of TABLES) {
    const row = table === 'claims' ? await claim(h.app) : await item(h.app);
    const inserted = await insert(h.app, table, row);
    const before = inserted.rows;
    const read = () =>
      sql`SELECT * FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(h.readonly);
    expect((await read()).rows).toEqual(before);
    for (const column of await columns(h.app, table)) {
      if (!MUTABLE[table].includes(column.name)) {
        expect(
          await sqlState(
            sql`UPDATE ${sql.table(`app.${table}`)}
          SET ${sql.ref(column.name)} = ${sql.ref(column.name)} WHERE id = ${row['id']}`.execute(
              h.app,
            ),
          ),
          column.name,
        ).toBe('42501');
      }
    }
    const next = table === 'claims' ? await claim(h.app) : await item(h.app);
    expect(await sqlState(insert(h.readonly, table, next))).toBe('42501');
    expect(await sqlState(update(h.readonly, table, row['id'], { updated_at: LATER }))).toBe(
      '42501',
    );
    for (const db of [h.app, h.readonly]) {
      expect(
        await sqlState(
          sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(db),
        ),
      ).toBe('42501');
      expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(db))).toBe('42501');
    }
    expect((await read()).rows).toEqual(before);
  }
});

it('[AC-B1-10a#30] application can write every mutable column without automatic row_version changes', async () => {
  await ready(h.app);
  const actor = await admin(h.app);
  const parent = await claim(h.app);
  await insert(h.app, 'claims', parent);
  const changes = {
    evidence_level: 'strong',
    status: 'auto_matched',
    handler_admin_id: actor,
    reason: 'synthetic review',
    updated_at: LATER,
  };
  expect((await update(h.app, 'claims', parent['id'], changes)).rows[0]).toMatchObject({
    ...changes,
    row_version: 0,
  });
  expect(
    (await update(h.app, 'claims', parent['id'], { row_version: 9 })).rows[0]?.['row_version'],
  ).toBe(9);
  const child = await item(h.app, parent);
  await insert(h.app, 'claim_items', child);
  const decision = {
    ...decided('rejected'),
    decided_by: actor,
    evidence: 'weak',
    evidence_link_log_ids: ['9007199254740993'],
    row_version: 1,
    updated_at: LATER,
  };
  const result = await update(h.app, 'claim_items', child['id'], decision);
  expect(result.rows[0]).toMatchObject({
    decision: 'rejected',
    reject_reason: 'OTHER',
    decided_by: actor,
    decided_at: LATER,
    evidence: 'weak',
    row_version: 1,
    updated_at: LATER,
  });
  expect((result.rows[0]?.['evidence_link_log_ids'] as unknown[]).map(String)).toEqual([
    '9007199254740993',
  ]);
});

it('[AC-B1-10a#31] no user trigger maintains decisions, versions or deletion policy', async () => {
  await ready(h.app);
  const result = await sql<{ name: string }>`SELECT tgname AS name FROM pg_trigger
    WHERE tgrelid IN (to_regclass('app.claims'), to_regclass('app.claim_items'))
    AND NOT tgisinternal`.execute(h.app);
  expect(result.rows).toEqual([]);
});
