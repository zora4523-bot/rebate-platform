// B1-13l §9.2: exercise the real AppModule and its PostgreSQL/Redis integration.
// Reuse B1-13h's unchanged fixture, but not its pre-10004 error assertion.
import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  BODY,
  CONFIG,
  NOW,
  SIGN,
  close,
  config,
  envelope,
  fixture,
  history,
  open,
  signed,
  type Kit,
  type Response,
} from '../labor-agreement/kit.ts';

let database: TestDatabase;
let server: TestRedis;
let kit: Kit;

beforeAll(async () => {
  database = await createTestDatabase();
  server = await acquireTestRedis();
  kit = await open(database, server);
});

beforeEach(() => {
  kit.clock.set(NOW);
  kit.lines.length = 0;
});

afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await server?.stop();
    } finally {
      await database?.drop();
    }
  }
});

function versionRequired(response: Response): void {
  // HTTP mapping is defined in contracts/error-codes.yaml; data must not carry fields.
  expect(response.statusCode, response.body).toBe(403);
  const body = response.json();
  expect(body).toMatchObject({
    code: 10004,
    msg: expect.any(String),
    trace_id: expect.any(String),
  });
  expect(body['data']).toEqual({ consent_type: 'labor_agreement' });
  const schema =
    kit.document.paths[SIGN]!['post']!.responses['4XX']!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}

it('[AC-B1-13l#2] 发布新版本后旧请求返回 10004、不新增记录；同键更正成功且成功结果可重放', async () => {
  const f = await fixture(kit);
  expect(envelope(kit, await f.get(), 0).data).toMatchObject({ version: 1 });
  await config(kit, f.appId, {
    'legal.labor_agreement.version': 2,
    'legal.labor_agreement.resign_from_version': 2,
  });
  kit.clock.advanceMs(61_000);
  const key = randomUUID();
  versionRequired(await f.sign(BODY, key));
  expect(await f.rows()).toEqual([]);

  // A cached 10004, or a retained hash of the rejected body, would prevent this correction.
  const corrected = { ...BODY, version: 2 };
  expect(signed(kit, await f.sign(corrected, key)).data).toEqual({});
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: f.appId,
    user_id: f.uid,
    type: 'labor_agreement',
    version: 2,
    accepted: true,
  });
  kit.clock.advanceMs(1000);
  signed(kit, await f.sign(corrected, key));
  expect(await f.rows()).toEqual(rows);
});

it.each([
  { ac: 3, version: 2 },
  { ac: 4, version: 4 },
])(
  '[AC-B1-13l#$ac] 当前版本为 3，提交版本 $version 返回 10004 且既有记录逐列不变',
  async ({ version }) => {
    const f = await fixture(kit, {
      config: { ...CONFIG, 'legal.labor_agreement.version': 3 },
    });
    await history(kit, f, 1, '2026-10-17T00:00:00Z');
    const before = await f.rows();
    expect(before).toHaveLength(1);
    versionRequired(await f.sign({ ...BODY, version }));
    expect(await f.rows()).toEqual(before);
  },
);

// Each scenario changes only the version between the two refusals. This checks both the new
// priority and the retained field validation, with a genuine red assertion in every case.
it.each([
  { ac: 5, invalid: { ...BODY, text_sha256: 'b'.repeat(64) }, fields: ['text_sha256'] },
  { ac: 6, invalid: { ...BODY, agreed: false }, fields: ['agreed'] },
  {
    ac: 7,
    invalid: { ...BODY, text_sha256: 'b'.repeat(64), agreed: false },
    fields: ['text_sha256', 'agreed'],
  },
])(
  '[AC-B1-13l#$ac] 版本与 $fields 同时不符优先 10004；只更正版本后 20001 仅列剩余不符项',
  async ({ invalid, fields }) => {
    const f = await fixture(kit);
    await history(kit, f, 1, '2026-10-17T00:00:00Z');
    const before = await f.rows();
    expect(before).toHaveLength(1);
    const key = randomUUID();
    versionRequired(await f.sign({ ...invalid, version: 2 }, key));
    expect(await f.rows()).toEqual(before);

    const response = await f.sign(invalid, key);
    const data = signed(kit, response, 20001).data;
    expect(data).toEqual({ fields: expect.arrayContaining(fields) });
    expect(data?.['fields']).toHaveLength(fields.length);
    expect(await f.rows()).toEqual(before);

    signed(kit, await f.sign(BODY, key));
    const after = await f.rows();
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter((row) => row['id'] === before[0]!['id'])).toEqual(before);
  },
);
