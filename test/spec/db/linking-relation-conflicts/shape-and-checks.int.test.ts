import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { columns, connect, sqlState } from '../linking-bindings/kit.ts';
import {
  OCCURRED,
  RESOLVED,
  SHAPE,
  TABLE,
  TIMEOUT,
  accepted,
  fixture,
  insert,
  requireShape,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

function contractPlatforms(): string[] {
  const source = readFileSync(
    new URL('../../../../contracts/enums/platform.yaml', import.meta.url),
    'utf8',
  );
  const block = /^  platform:\n([\s\S]*?)(?=^  \w+:)/m.exec(source)?.[1];
  const values = [...(block ?? '').matchAll(/^      ([a-z][a-z0-9_]*):/gm)].map(
    (match) => match[1]!,
  );
  expect(values.length, 'platform contract must be readable').toBeGreaterThan(0);
  return values;
}

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
  '[AC-B1-06y#1] conflict storage has the required column types and nullability',
  async () => {
    await requireShape();
    const primary = await sql<{ names: string[] }>`SELECT ARRAY(
    SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord
  ) AS names FROM pg_constraint c
  WHERE c.conrelid = to_regclass('app.union_binding_conflicts') AND c.contype = 'p'`.execute(app);
    expect(primary.rows).toEqual([{ names: ['id'] }]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#2] no counterparty identifiers or private profile columns are persisted',
  async () => {
    await requireShape();
    const names = (await columns(TABLE)).map((column) => column.name);
    expect(
      names.filter((name) => /token|secret|nick|avatar|account_?name|relation_?id/i.test(name)),
    ).toEqual([]);
    expect(names.filter((name) => /user_?id/i.test(name) && name !== 'user_id')).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#3] required columns reject NULL and ids cannot be duplicated',
  async () => {
    await requireShape();
    const row = await accepted(app);
    for (const { name } of SHAPE.filter((column) => !column.nullable)) {
      expect(await sqlState(insert(app, { ...row, id: randomUUID(), [name]: null })), name).toBe(
        '23502',
      );
    }
    expect(await sqlState(insert(app, row))).toBe('23505');
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#4] kind and resolution are constrained by explicit CHECK literals',
  async () => {
    await requireShape();
    const checks = await sql<{ definition: string; validated: boolean }>`
    SELECT pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
    FROM pg_constraint c WHERE c.conrelid = to_regclass('app.union_binding_conflicts')
      AND c.contype = 'c'`.execute(app);
    for (const [column, expected] of [
      ['kind', ['occupied', 'cooling', 'rebind']],
      ['resolution', ['bound_active', 'already_active']],
    ] as const) {
      const relevant = checks.rows.filter(({ definition }) =>
        new RegExp(`\\b${column}\\b`).test(definition),
      );
      expect(relevant.length, column).toBeGreaterThan(0);
      expect(
        relevant.every(({ validated }) => validated),
        column,
      ).toBe(true);
      const literals = relevant.flatMap(({ definition }) =>
        [...definition.matchAll(/'([^']*)'/g)].map((match) => match[1]!),
      );
      expect([...new Set(literals)].sort(), column).toEqual([...expected].sort());
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#5] every conflict kind can be unresolved, bound_active, or already_active at insertion',
  async () => {
    await requireShape();
    for (const kind of ['occupied', 'cooling', 'rebind']) {
      for (const state of [
        { resolved_at: null, resolution: null },
        { resolved_at: RESOLVED, resolution: 'bound_active' },
        { resolved_at: OCCURRED, resolution: 'already_active' },
        { resolved_at: OCCURRED, resolution: 'bound_active' },
      ]) {
        const row = await accepted(app, { kind, ...state });
        const result = await sql<{
          kind: string;
          resolved_at: Date | null;
          resolution: string | null;
        }>`
        SELECT kind, resolved_at, resolution FROM app.union_binding_conflicts WHERE id = ${row.id}
      `.execute(app);
        expect(result.rows).toEqual([{ kind, ...state }]);
      }
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#6] unknown or incorrectly cased kinds and resolutions fail CHECK',
  async () => {
    await requireShape();
    const row = await fixture();
    for (const kind of ['', 'other', 'OCCUPIED', ' occupied ', 'bound_active']) {
      expect(await sqlState(insert(app, { ...row, id: randomUUID(), kind })), kind).toBe('23514');
    }
    for (const resolution of ['', 'manual', 'BOUND_ACTIVE', ' bound_active ', 'active']) {
      expect(
        await sqlState(
          insert(app, {
            ...row,
            id: randomUUID(),
            resolved_at: RESOLVED,
            resolution,
          }),
        ),
        resolution,
      ).toBe('23514');
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#7] platform accepts all contract values and rejects non-platform values',
  async () => {
    await requireShape();
    for (const platform of contractPlatforms()) {
      const row = await accepted(app, { platform });
      expect(
        (
          await sql<{ platform: string }>`SELECT platform FROM app.union_binding_conflicts
      WHERE id = ${row.id}`.execute(app)
        ).rows,
      ).toEqual([{ platform }]);
    }
    const row = await fixture();
    for (const platform of ['', 'unknown_platform', 'TAOBAO', 'taobao ', 'tmall']) {
      // CHECK runs before FK checks; the valid account does not hide invalid platform acceptance.
      expect(await sqlState(insert(app, { ...row, id: randomUUID(), platform })), platform).toBe(
        '23514',
      );
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#8] resolution and resolved_at must be both NULL or both populated',
  async () => {
    await requireShape();
    const row = await fixture();
    for (const state of [
      { resolved_at: RESOLVED, resolution: null },
      { resolved_at: null, resolution: 'bound_active' },
      { resolved_at: null, resolution: 'already_active' },
    ]) {
      expect(await sqlState(insert(app, { ...row, id: randomUUID(), ...state }))).toBe('23514');
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#9] resolution before occurrence fails CHECK for either resolution value',
  async () => {
    await requireShape();
    const row = await fixture();
    for (const resolution of ['bound_active', 'already_active']) {
      expect(
        await sqlState(
          insert(app, {
            ...row,
            id: randomUUID(),
            resolved_at: new Date('2026-10-09T00:59:59.999Z'),
            resolution,
          }),
        ),
      ).toBe('23514');
    }
  },
  TIMEOUT,
);
