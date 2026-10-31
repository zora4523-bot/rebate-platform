// F1-02zzr §9.3 items 1–5 (D10-465; 04 §3.2 agreements). The integration globalSetup alone reads
// the admin database URL and applies migrations; tests use business roles and no migration number.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  NEW_TYPES,
  OTHER_CHECKS,
  TYPES,
  accepts,
  appId,
  fixture,
  norm,
  ready,
  refuses,
  type Connection,
  type Row,
} from './sdk-collect-kit.ts';

let database: TestDatabase;
let app: Connection;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});
afterAll(async () => {
  if (app) await destroyDb(app);
  await database?.drop();
});

async function constraints() {
  return (
    await sql<{
      name: string;
      type: string;
      validated: boolean;
      definition: string;
    }>`SELECT conname AS name, contype::text AS type, convalidated AS validated,
        pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = to_regclass('app.agreements')
        AND contype IN ('p', 'u', 'c') ORDER BY conname`.execute(app)
  ).rows;
}

it('[F1-02zzr#1] agreements_type_check is one validated plain IN-list of exactly the five types; other constraints unchanged', async () => {
  await ready(app);
  const all = (await constraints()).map((c) => ({ ...c, definition: norm(c.definition) }));
  const typeChecks = all.filter((c) => c.name === 'agreements_type_check');
  expect(typeChecks.map(({ type, validated }) => ({ type, validated }))).toEqual([
    { type: 'c', validated: true },
  ]);
  // A plain case-sensitive equality list on the raw column: no lower(), ILIKE, regex or trim.
  const definition = typeChecks[0]!.definition;
  const list = /^CHECK \(\(type = ANY \(ARRAY\[(.+)\]\)\)\)$/.exec(definition);
  expect(list, definition).not.toBeNull();
  const items = list![1]!.split(', ');
  for (const item of items) expect(item, definition).toMatch(/^'[a-z_]+'::text$/);
  const values = items.map((item) => item.slice(1, item.indexOf("'", 1))).sort();
  expect(values, definition).toEqual([...TYPES].sort());
  // Every other CHECK keeps its 0045 name, definition and validation.
  const others = all
    .filter((c) => c.type === 'c' && c.name !== 'agreements_type_check')
    .map(({ name, validated, definition }) => ({ name, validated, definition }));
  expect(others).toEqual(
    Object.entries(OTHER_CHECKS)
      .map(([name, definition]) => ({ name, validated: true, definition }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  const keys = all.filter((c) => c.type !== 'c');
  expect(keys).toEqual([
    {
      name: 'agreements_app_type_version_key',
      type: 'u',
      validated: true,
      definition: 'UNIQUE (app_id, type, version)',
    },
    { name: 'agreements_pkey', type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
  ]);
});

it('[F1-02zzr#2] each of the five types inserts and is stored exactly as given', async () => {
  const base = await fixture(app);
  for (const type of TYPES) {
    await accepts(
      app,
      { ...base, id: randomUUID(), type, requires_resign: type === 'labor_agreement' },
      type,
    );
  }
  const all = await sql<Row>`SELECT type, version, min_version, requires_resign
    FROM app.agreements WHERE app_id = ${base.app_id} ORDER BY type`.execute(app);
  expect(all.rows).toEqual(
    [...TYPES].sort().map((type) => ({
      type,
      version: 1,
      min_version: 1,
      requires_resign: type === 'labor_agreement',
    })),
  );
});

it('[F1-02zzr#3] near-miss spellings of the types fail agreements_type_check and leave no row', async () => {
  const base = await fixture(app);
  // Control: the exact new values pass for this same fixture, so the rejections below are
  // caused by the spelling alone.
  for (const type of NEW_TYPES) {
    await accepts(app, { ...base, id: randomUUID(), type }, type);
  }
  for (const type of [
    '',
    'SDK_LIST',
    'Sdk_list',
    'sdk_list ',
    ' collect_list',
    'collect_list\n',
    'collectlist',
    'sdk-list',
    'labor',
    'privacy ',
    'COLLECT_LIST',
    'sdk_lists',
  ]) {
    await refuses(
      app,
      { ...base, id: randomUUID(), app_id: appId(), type },
      'agreements_type_check',
      JSON.stringify(type),
    );
  }
});

it('[F1-02zzr#4] sdk_list and collect_list never require resigning, at any version or minimum', async () => {
  const base = await fixture(app);
  for (const type of NEW_TYPES) {
    for (const [version, min_version] of [
      [1, 1],
      [2, 1],
      [3, 3],
    ] as const) {
      const row = { ...base, type, version, min_version };
      await refuses(
        app,
        { ...row, id: randomUUID(), requires_resign: true },
        'agreements_requires_resign_check',
        `${type} v${version} min${min_version} resign`,
      );
      await accepts(
        app,
        { ...row, id: randomUUID(), requires_resign: false },
        `${type} v${version} min${min_version}`,
      );
    }
  }
  // The labor rule is untouched: labor v1 still must require resigning.
  await refuses(
    app,
    { ...base, id: randomUUID(), type: 'labor_agreement', requires_resign: false },
    'agreements_requires_resign_check',
    'labor v1 without resign',
  );
});

it('[F1-02zzr#5] sdk_list and collect_list are each unique per app and version; other types, apps and versions do not collide', async () => {
  const base = await fixture(app);
  for (const type of TYPES) {
    await accepts(
      app,
      { ...base, id: randomUUID(), type, requires_resign: type === 'labor_agreement' },
      `${type} v1`,
    );
  }
  for (const type of NEW_TYPES) {
    await refuses(
      app,
      { ...base, id: randomUUID(), type },
      'agreements_app_type_version_key',
      `${type} v1 duplicate`,
      '23505',
    );
    await accepts(app, { ...base, id: randomUUID(), type, version: 2 }, `${type} v2`);
    await accepts(app, { ...base, id: randomUUID(), app_id: appId(), type }, `${type} other app`);
  }
  const counts = await sql<{ type: string; versions: number[] }>`SELECT type,
      array_agg(version ORDER BY version) AS versions
    FROM app.agreements WHERE app_id = ${base.app_id} GROUP BY type ORDER BY type`.execute(app);
  expect(counts.rows).toEqual(
    [...TYPES].sort().map((type) => ({
      type,
      versions: (NEW_TYPES as readonly string[]).includes(type) ? [1, 2] : [1],
    })),
  );
});
