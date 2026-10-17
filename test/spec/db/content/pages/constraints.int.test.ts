import { randomUUID } from 'node:crypto';

import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  EXPIRES,
  appId,
  insert,
  rejects,
  rows,
  seeded,
  tokenHash,
  type Connection,
  type Row,
} from './kit.ts';

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

it('[AC-F1-09a#6] page keys accept home/custom syntax with exact lowercase and length boundaries', async () => {
  const data = await rows(app);
  const invalid = [
    '',
    'Home',
    'custom:',
    'custom:A',
    'custom:x/y',
    'a'.repeat(65),
    `custom:${'a'.repeat(58)}`,
    'xhome',
    'homex',
    'home\n',
    ' home',
    'xcustom:a',
    'custom:a!',
    'custom:a\n',
  ];
  const valid = ['home', 'custom:a', 'custom:a_b-1', `custom:${'a'.repeat(57)}`];
  for (const table of ['pages', 'page_versions'] as const) {
    const base = table === 'pages' ? data.page : data.version;
    for (const page_key of invalid) {
      await rejects(insert(app, table, { ...base, page_key }), `${table}_page_key_check`);
    }
    for (const page_key of valid) {
      expect(await insert(app, table, { ...base, page_key })).toMatchObject({ page_key });
    }
  }
});

it('[AC-F1-09a#7] versions start at one and sections must be a JSON array', async () => {
  const { version } = await rows(app);
  for (const bad of [0, -1]) {
    await rejects(
      insert(app, 'page_versions', { ...version, version: bad }),
      'page_versions_version_check',
    );
  }
  for (const sections of ['{}', '"text"', 'null', '42', 'true']) {
    await rejects(
      insert(app, 'page_versions', { ...version, sections }),
      'page_versions_sections_check',
    );
  }
  for (const [number, sections] of [
    [1, '[]'],
    [2147483647, '[{"type":"banner"}]'],
  ] as const) {
    expect(
      await insert(app, 'page_versions', { ...version, version: number, sections }),
    ).toMatchObject({ version: number, sections: JSON.parse(sections) as unknown });
  }
});

it('[AC-F1-09a#8] statuses and publication metadata obey the complete nullability truth table', async () => {
  const { version, admin } = await rows(app);
  for (const status of ['', 'pending', 'Published', 'rollback']) {
    await rejects(
      insert(app, 'page_versions', { ...version, status, publish_at: AT, publisher: admin.id }),
      'page_versions_status_check',
    );
  }
  let number = 1;
  for (const status of ['draft', 'published', 'rolled_back']) {
    for (const publish_at of [null, AT]) {
      for (const publisher of [null, admin.id]) {
        const candidate = { ...version, version: number++, status, publish_at, publisher };
        const valid =
          status === 'draft'
            ? publish_at === null && publisher === null
            : publish_at !== null && publisher !== null;
        if (valid) {
          expect(await insert(app, 'page_versions', candidate)).toMatchObject({
            status,
            publish_at,
            publisher,
          });
        } else {
          await rejects(insert(app, 'page_versions', candidate), 'page_versions_publish_check');
        }
      }
    }
  }
});

it('[AC-F1-09a#9] counters reject negative values and retain bigint precision independently', async () => {
  const { version } = await rows(app);
  for (const changes of [
    { render_count: -1n },
    { error_count: -1n },
    { render_count: -1n, error_count: -1n },
  ]) {
    await rejects(
      insert(app, 'page_versions', { ...version, ...changes }),
      'page_versions_counts_check',
    );
  }
  // This migration imposes non-negativity only, not error_count <= render_count.
  expect(
    await insert(app, 'page_versions', { ...version, render_count: 0n, error_count: 1n }),
  ).toMatchObject({ render_count: 0n, error_count: 1n });
  const big = 9007199254740993n;
  expect(
    await insert(app, 'page_versions', {
      ...version,
      version: 2,
      render_count: big,
      error_count: big,
    }),
  ).toMatchObject({ render_count: big, error_count: big });
});

it('[AC-F1-09a#10] gray percent outside 0..100 is rejected by the named range check', async () => {
  const { page } = await rows(app);
  for (const gray_percent of [-1, 101]) {
    // Both gray CHECKs reject these values; do not depend on PG's check order.
    await expect(insert(app, 'pages', { ...page, gray_percent })).rejects.toMatchObject({
      code: '23514',
      constraint: expect.stringMatching(/^pages_gray(?:_percent)?_check$/),
    });
  }
  // Catalog assertion pins the independent range check (not merely the pairing check).
  const range = await sql<{ def: string }>`SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = to_regclass('app.pages')
      AND conname = 'pages_gray_percent_check' AND contype = 'c'`.execute(app);
  expect(range.rows).toHaveLength(1);
  expect(range.rows[0]!.def).toMatch(/gray_percent\s*>=\s*0/);
  expect(range.rows[0]!.def).toMatch(/gray_percent\s*<=\s*100/);
});

it('[AC-F1-09a#11] gray version requires a distinct full version and a percent from 1 through 99', async () => {
  const { page, version } = await seeded(app);
  const invalid: Row[] = [
    { current_version: 1, gray_version: 2, gray_percent: 0 },
    { current_version: 1, gray_version: 2, gray_percent: 100 },
    { current_version: null, gray_version: 2, gray_percent: 1 },
    { current_version: 1, gray_version: 1, gray_percent: 1 },
    { current_version: 1, gray_version: null, gray_percent: 1 },
    { current_version: 1, gray_version: null, gray_percent: 100 },
    { current_version: null, gray_version: null, gray_percent: 99 },
  ];
  for (const change of invalid) {
    await rejects(insert(app, 'pages', { ...page, ...change }), 'pages_gray_check');
  }
  const valid: Row[] = [
    { current_version: null, gray_version: null, gray_percent: 0 },
    { current_version: 1, gray_version: null, gray_percent: 0 },
    { current_version: 1, gray_version: 2, gray_percent: 1 },
    { current_version: 1, gray_version: 2, gray_percent: 99 },
  ];
  for (const change of valid) {
    const id = appId();
    await insert(app, 'page_versions', { ...version, app_id: id });
    await insert(app, 'page_versions', { ...version, app_id: id, version: 2 });
    expect(await insert(app, 'pages', { ...page, app_id: id, ...change })).toMatchObject(change);
  }
});

it('[AC-F1-09a#12] page revision and preview usage are nonnegative integers', async () => {
  const { page, token } = await seeded(app);
  await rejects(insert(app, 'pages', { ...page, revision: -1 }), 'pages_revision_check');
  await rejects(
    insert(app, 'page_preview_tokens', { ...token, used_count: -1 }),
    'page_preview_tokens_used_count_check',
  );
  for (const value of [0, 1, 2147483647]) {
    expect(await insert(app, 'pages', { ...page, app_id: appId(), revision: value })).toMatchObject(
      { revision: value },
    );
    expect(
      await insert(app, 'page_preview_tokens', {
        ...token,
        token_hash: tokenHash(),
        used_count: value,
      }),
    ).toMatchObject({ used_count: value });
  }
});

it('[AC-F1-09a#13] preview tokens store exactly 64 lowercase hexadecimal characters', async () => {
  const { token } = await seeded(app);
  const hash = '0123456789abcdef'.repeat(4);
  for (const token_hash of [
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    `x${hash}`,
    `${hash}\n`,
    `${hash}!`,
  ]) {
    await rejects(
      insert(app, 'page_preview_tokens', { ...token, token_hash }),
      'page_preview_tokens_token_hash_check',
    );
  }
  expect(await insert(app, 'page_preview_tokens', { ...token, token_hash: hash })).toMatchObject({
    token_hash: hash,
  });
});

it('[AC-F1-09a#14] preview expiry is explicit and strictly within ten minutes of its Clock creation time', async () => {
  const { token } = await seeded(app);
  for (const expire_at of [
    new Date('2026-10-17T07:59:59.999Z'),
    AT,
    new Date('2026-10-17T08:10:00.001Z'),
  ]) {
    await rejects(
      insert(app, 'page_preview_tokens', { ...token, expire_at }),
      'page_preview_tokens_expire_at_check',
    );
  }
  const missing = { ...token };
  delete missing.expire_at;
  await expect(insert(app, 'page_preview_tokens', missing)).rejects.toMatchObject({
    code: '23502',
    column: 'expire_at',
  });
  for (const expire_at of [new Date('2026-10-17T08:00:00.001Z'), EXPIRES]) {
    expect(
      await insert(app, 'page_preview_tokens', { ...token, token_hash: tokenHash(), expire_at }),
    ).toMatchObject({ created_at: AT, expire_at });
  }
});

it('[AC-F1-09a#15] full, gray and preview references cannot borrow a version from another app or page', async () => {
  const { page, version, token } = await seeded(app);
  // Version 3 exists only in another app; 4 exists only on another page.
  await insert(app, 'page_versions', { ...version, app_id: appId(), version: 3 });
  await insert(app, 'page_versions', { ...version, page_key: 'custom:other', version: 4 });
  for (const number of [0, 3, 4, 5]) {
    await rejects(
      insert(app, 'pages', { ...page, current_version: number }),
      'pages_current_version_fkey',
      '23503',
    );
    await rejects(
      insert(app, 'pages', { ...page, current_version: 1, gray_version: number, gray_percent: 50 }),
      'pages_gray_version_fkey',
      '23503',
    );
    await rejects(
      insert(app, 'page_preview_tokens', { ...token, version: number }),
      'page_preview_tokens_version_fkey',
      '23503',
    );
  }
  expect(
    await insert(app, 'pages', { ...page, current_version: 1, gray_version: 2, gray_percent: 50 }),
  ).toMatchObject({ current_version: 1, gray_version: 2, gray_percent: 50 });
  expect(await insert(app, 'page_preview_tokens', token)).toMatchObject({ version: 1 });
});

it('[AC-F1-09a#16] all four admin references reject missing accounts and accept existing accounts', async () => {
  const { page, version, token, admin } = await seeded(app);
  await rejects(
    insert(app, 'page_versions', { ...version, version: 3, created_by_admin_id: randomUUID() }),
    'page_versions_created_by_admin_id_fkey',
    '23503',
  );
  await rejects(
    insert(app, 'page_versions', {
      ...version,
      version: 3,
      status: 'published',
      publish_at: AT,
      publisher: randomUUID(),
    }),
    'page_versions_publisher_fkey',
    '23503',
  );
  await rejects(
    insert(app, 'pages', { ...page, updated_by_admin_id: randomUUID() }),
    'pages_updated_by_admin_id_fkey',
    '23503',
  );
  await rejects(
    insert(app, 'page_preview_tokens', { ...token, created_by: randomUUID() }),
    'page_preview_tokens_created_by_fkey',
    '23503',
  );
  expect(
    await insert(app, 'page_versions', {
      ...version,
      version: 3,
      status: 'published',
      publish_at: AT,
      publisher: admin.id,
    }),
  ).toMatchObject({ publisher: admin.id, created_by_admin_id: admin.id });
  expect(await insert(app, 'pages', { ...page, updated_by_admin_id: admin.id })).toMatchObject({
    updated_by_admin_id: admin.id,
  });
  expect(await insert(app, 'page_preview_tokens', token)).toMatchObject({ created_by: admin.id });
});

it('[AC-F1-09a#17] primary keys reject duplicates and token hashes stay globally unique across apps', async () => {
  const { page, version, token } = await seeded(app);
  await insert(app, 'pages', page);
  await insert(app, 'page_preview_tokens', token);
  await rejects(insert(app, 'pages', page), 'pages_pkey', '23505');
  await rejects(insert(app, 'page_versions', version), 'page_versions_pkey', '23505');
  await rejects(insert(app, 'page_preview_tokens', token), 'page_preview_tokens_pkey', '23505');
  const other = appId();
  await insert(app, 'page_versions', { ...version, app_id: other });
  await rejects(
    insert(app, 'page_preview_tokens', { ...token, app_id: other }),
    'page_preview_tokens_pkey',
    '23505',
  );
  expect(await insert(app, 'pages', { ...page, app_id: other })).toMatchObject({ app_id: other });
  expect(
    await insert(app, 'page_versions', { ...version, page_key: 'custom:other' }),
  ).toMatchObject({ page_key: 'custom:other' });
  expect(await insert(app, 'pages', { ...page, page_key: 'custom:other' })).toMatchObject({
    page_key: 'custom:other',
  });
  // Multiple independent preview tokens may point to the same immutable version.
  expect(
    await insert(app, 'page_preview_tokens', { ...token, token_hash: tokenHash() }),
  ).toMatchObject({ version: 1 });
});
