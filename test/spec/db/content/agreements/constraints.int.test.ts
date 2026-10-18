import { randomUUID } from 'node:crypto';

import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { SHAPE, appId, fixture, insert, rejects, type Connection } from './kit.ts';

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

it('[AC-F1-02k#6] type accepts exactly privacy, agreement and labor_agreement', async () => {
  const row = await fixture(app);
  for (const type of ['', 'sdk_list', 'Privacy', 'AGREEMENT', 'labor', 'privacy ', 'privacy\n']) {
    await rejects(insert(app, { ...row, type }), 'agreements_type_check');
  }
  for (const type of ['privacy', 'agreement', 'labor_agreement']) {
    expect(
      await insert(app, {
        ...row,
        id: randomUUID(),
        type,
        requires_resign: type === 'labor_agreement',
      }),
    ).toMatchObject({ type });
  }
});

it('[AC-F1-02k#7] version must be positive; min_version lies in 1..version inclusive', async () => {
  const row = await fixture(app);
  // Nonpositive versions also violate 1 <= min_version <= version. Either CHECK may
  // reject first; #3 separately requires both named constraints to exist and be validated.
  for (const version of [0, -1]) {
    await expect(insert(app, { ...row, version })).rejects.toMatchObject({ code: '23514' });
  }
  for (const min_version of [0, -1, 3]) {
    await rejects(insert(app, { ...row, version: 2, min_version }), 'agreements_min_version_check');
  }
  for (const [version, min_version] of [
    [1, 1],
    [2, 1],
    [3, 3],
    [2147483647, 2147483647],
  ]) {
    expect(await insert(app, { ...row, id: randomUUID(), version, min_version })).toMatchObject({
      version,
      min_version,
    });
  }
});

it('[AC-F1-02k#8] non-labor agreements never require resigning, including minimum-version bumps', async () => {
  const row = await fixture(app);
  for (const type of ['privacy', 'agreement']) {
    for (const min_version of [1, 2]) {
      await rejects(
        insert(app, { ...row, type, version: 2, min_version, requires_resign: true }),
        'agreements_requires_resign_check',
      );
      expect(
        await insert(app, {
          ...row,
          id: randomUUID(),
          app_id: appId(),
          type,
          version: 2,
          min_version,
          requires_resign: false,
        }),
      ).toMatchObject({ type, min_version, requires_resign: false });
    }
  }
});

it('[AC-F1-02k#9] labor requires_resign equals min_version=version; first version must require it', async () => {
  const row = { ...(await fixture(app)), type: 'labor_agreement' };
  for (const [version, min_version, requires_resign] of [
    [1, 1, false],
    [2, 2, false],
    [2, 1, true],
  ] as const) {
    await rejects(
      insert(app, { ...row, version, min_version, requires_resign }),
      'agreements_requires_resign_check',
    );
  }
  for (const [version, min_version, requires_resign] of [
    [1, 1, true],
    [2, 1, false],
    [3, 3, true],
  ] as const) {
    expect(
      await insert(app, { ...row, id: randomUUID(), version, min_version, requires_resign }),
    ).toMatchObject({ version, min_version, requires_resign });
  }
});

it('[AC-F1-02k#10] digest accepts exactly 64 lowercase hexadecimal characters', async () => {
  const row = await fixture(app);
  for (const text_sha256 of ['', '0'.repeat(63), '0'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
    await rejects(insert(app, { ...row, text_sha256 }), 'agreements_text_sha256_check');
  }
  for (const text_sha256 of ['0'.repeat(64), 'abcdef0123456789'.repeat(4)]) {
    expect(
      await insert(app, { ...row, id: randomUUID(), app_id: appId(), text_sha256 }),
    ).toMatchObject({ text_sha256 });
  }
});

it('[AC-F1-02k#11] publication URL must start with lowercase https://', async () => {
  const row = await fixture(app);
  for (const url of [
    '',
    'http://example.test',
    'HTTPS://example.test',
    '/agreement',
    'xhttps://example.test',
  ]) {
    await rejects(insert(app, { ...row, url }), 'agreements_url_check');
  }
  expect(await insert(app, row)).toMatchObject({ url: row.url });
});

it('[AC-F1-02k#12] every publication requires nonblank legal reviewer and note', async () => {
  const row = await fixture(app);
  // privacy v1 needs no resign or minimum-version bump: legal confirmation is still mandatory.
  for (const column of ['legal_confirmed_by', 'legal_confirm_note']) {
    await expect(insert(app, { ...row, [column]: null })).rejects.toMatchObject({
      code: '23502',
      column,
    });
    for (const value of ['', '  ']) {
      await rejects(insert(app, { ...row, [column]: value }), 'agreements_legal_confirm_check');
    }
  }
  expect(
    await insert(app, { ...row, legal_confirmed_by: ' Legal ', legal_confirm_note: ' Confirmed ' }),
  ).toMatchObject({ legal_confirmed_by: ' Legal ', legal_confirm_note: ' Confirmed ' });
});

it('[AC-F1-02k#13] all mandatory columns reject NULL; publication time and id cannot be omitted', async () => {
  const row = await fixture(app);
  for (const column of Object.keys(SHAPE)) {
    await expect(insert(app, { ...row, [column]: null })).rejects.toMatchObject({
      code: '23502',
      column,
    });
  }
  for (const column of ['id', 'published_at']) {
    const omitted = { ...row };
    delete omitted[column];
    await expect(insert(app, omitted)).rejects.toMatchObject({ code: '23502', column });
  }
});

it('[AC-F1-02k#14] uniqueness is app/type/version; other apps, types and versions remain insertable', async () => {
  const row = await fixture(app);
  await insert(app, row);
  await rejects(
    insert(app, { ...row, id: randomUUID() }),
    'agreements_app_type_version_key',
    '23505',
  );
  for (const changes of [{ app_id: appId() }, { type: 'agreement' }, { version: 2 }]) {
    expect(await insert(app, { ...row, ...changes, id: randomUUID() })).toMatchObject(changes);
  }
  await expect(insert(app, { ...row, app_id: appId() })).rejects.toMatchObject({ code: '23505' });
});

it('[AC-F1-02k#15] article reference must match both UUID and revision; publisher must exist', async () => {
  const row = await fixture(app);
  await rejects(
    insert(app, { ...row, article_id: randomUUID() }),
    'agreements_article_fkey',
    '23503',
  );
  await rejects(insert(app, { ...row, article_version: 2 }), 'agreements_article_fkey', '23503');
  await rejects(
    insert(app, { ...row, published_by: randomUUID() }),
    'agreements_published_by_fkey',
    '23503',
  );
  expect(await insert(app, row)).toMatchObject({
    article_id: row.article_id,
    article_version: 1,
    published_by: row.published_by,
  });
});
