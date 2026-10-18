import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  BODY,
  CONFIG,
  NOW,
  PATH,
  SHA,
  SIGN,
  close,
  config,
  envelope,
  fixture,
  history,
  open,
  port,
  privateDataAbsent,
  signed,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let server: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  server = await acquireTestRedis();
  kit = await open(database, server);
});
beforeEach(() => {
  if (kit) {
    kit.clock.set(NOW);
    kit.lines.length = 0;
  }
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

// The JSON layout of signer_snapshot is internal, not fixed by the contract. Assert the
// retained values independently of nesting/field names; the full row must not contain PII.
function leaves(value: unknown): unknown[] {
  return value !== null && typeof value === 'object'
    ? Object.values(value).flatMap(leaves)
    : [value];
}

it('[AC-B1-13h#1] 两条操作解除 planned 并由真实 AppModule 提供', async () => {
  expect(kit.document.paths[PATH]!['get']!['x-implementation']).not.toBe('planned');
  expect(kit.document.paths[SIGN]!['post']!['x-implementation']).not.toBe('planned');
  const f = await fixture(kit);
  envelope(kit, await f.get(), 0);
  signed(kit, await f.sign());
});

it('[AC-B1-13h#2] 从未签署返回当前全文、摘要、need_sign=true 与空签署历史，GET 不写库', async () => {
  const f = await fixture(kit);
  const before = await f.rows();
  const response = await f.get();
  expect(envelope(kit, response, 0).data).toEqual({
    version: 1,
    text_url: CONFIG['legal.labor_agreement.text_url'],
    text_sha256: SHA,
    need_sign: true,
    signed_version: null,
    signed_at: null,
  });
  expect(await f.rows()).toEqual(before);
  privateDataAbsent(kit, [response]);
});

it('[AC-B1-13h#3] 签署只插一条用户级记录，保留设备、Clock、摘要及双方快照，不需 step-up', async () => {
  const f = await fixture(kit);
  const response = await f.sign();
  expect(signed(kit, response).data).toEqual({});
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: f.appId,
    subject_type: 'user',
    user_id: f.uid,
    device_id: f.deviceId,
    type: 'labor_agreement',
    version: 1,
    accepted: true,
    channel: 'withdraw_flow',
    text_sha256: SHA,
    client_at: new Date(NOW),
    server_at: new Date(NOW),
    created_at: new Date(NOW),
  });
  expect(leaves(rows[0]!['signer_snapshot'])).toEqual(
    expect.arrayContaining([
      CONFIG['legal.operator_entity.name'],
      CONFIG['legal.operator_entity.credit_code'],
      f.uid,
      f.realnameId,
      '***明',
    ]),
  );
  const get = await f.get();
  const data = envelope(kit, get, 0).data!;
  expect(data).toMatchObject({ need_sign: false, signed_version: 1 });
  expect(new Date(String(data['signed_at'])).getTime()).toBe(new Date(NOW).getTime());
  privateDataAbsent(kit, [response, get], rows);
});

it('[AC-B1-13h#4] 新版本未要求重签时旧签署持续有效，调高门槛后须签新版本', async () => {
  const f = await fixture(kit);
  signed(kit, await f.sign());
  await config(kit, f.appId, {
    'legal.labor_agreement.version': 2,
    'legal.labor_agreement.text_url': 'https://example.test/legal/labor-v2.html',
    'legal.labor_agreement.text_sha256': 'b'.repeat(64),
  });
  kit.clock.advanceMs(61_000); // Expire the existing content reader's ordinary config cache.
  expect(envelope(kit, await f.get(), 0).data).toMatchObject({
    version: 2,
    text_url: 'https://example.test/legal/labor-v2.html',
    text_sha256: 'b'.repeat(64),
    need_sign: false,
    signed_version: 1,
  });
  await config(kit, f.appId, { 'legal.labor_agreement.resign_from_version': 2 });
  kit.clock.advanceMs(61_000);
  expect(envelope(kit, await f.get(), 0).data).toMatchObject({
    need_sign: true,
    signed_version: 1,
  });
  signed(kit, await f.sign({ version: 2, text_sha256: 'b'.repeat(64), agreed: true }));
  expect(envelope(kit, await f.get(), 0).data).toMatchObject({
    need_sign: false,
    signed_version: 2,
  });
  expect(await f.rows()).toHaveLength(2);
});

it('[AC-B1-13h#5] 最近状态按 server_at 取整条，不能取最高版本或最后插入的 id', async () => {
  const f = await fixture(kit, {
    config: {
      ...CONFIG,
      'legal.labor_agreement.version': 3,
      'legal.labor_agreement.resign_from_version': 2,
    },
  });
  const latest = '2026-10-17T09:30:00+08:00';
  await history(kit, f, 1, latest);
  await history(kit, f, 3, '2026-10-16T09:30:00+08:00');
  // A newer consent of a different type must not hide the labor agreement.
  await history(kit, f, 3, '2026-10-18T09:30:00+08:00', 'agreement');
  const before = await f.rows();
  const data = envelope(kit, await f.get(), 0).data!;
  expect(data).toMatchObject({ need_sign: true, signed_version: 1 });
  expect(new Date(String(data['signed_at'])).getTime()).toBe(new Date(latest).getTime());
  expect(await f.rows()).toEqual(before);
});

it('[AC-B1-13h#6] 同版本新键再次签署新增行，主体配置变更不改旧记录', async () => {
  const f = await fixture(kit);
  signed(kit, await f.sign());
  const original = (await f.rows())[0]!;
  await config(kit, f.appId, {
    'legal.operator_entity.name': '变更后测试主体',
    'legal.operator_entity.credit_code': '91310000MA1FL8CM1M',
  });
  kit.clock.advanceMs(61_000);
  const response = await f.sign();
  signed(kit, response);
  const rows = await f.rows();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(original);
  expect(rows[1]!['id']).not.toBe(original['id']);
  expect(leaves(rows[1]!['signer_snapshot'])).toEqual(
    expect.arrayContaining(['变更后测试主体', '91310000MA1FL8CM1M', f.uid, f.realnameId, '***明']),
  );
  expect(rows[1]!['server_at']).toEqual(kit.clock.now());
  const data = envelope(kit, await f.get(), 0).data!;
  expect(new Date(String(data['signed_at'])).getTime()).toBe(kit.clock.now().getTime());
  privateDataAbsent(kit, [response], rows);
});

it('[AC-B1-13h#7] 同一幂等键重放返回首次结果，只留一条签署记录', async () => {
  const f = await fixture(kit);
  const key = randomUUID();
  const first = await f.sign(BODY, key);
  signed(kit, first);
  const before = await f.rows();
  kit.clock.advanceMs(1000);
  const replay = await f.sign(BODY, key);
  expect(signed(kit, replay).data).toEqual(first.json<{ data: unknown }>().data);
  expect(before).toHaveLength(1);
  expect(await f.rows()).toEqual(before);
});

it.each([
  { body: { ...BODY, version: 2 }, fields: ['version'] },
  { body: { ...BODY, text_sha256: 'b'.repeat(64) }, fields: ['text_sha256'] },
  { body: { ...BODY, agreed: false }, fields: ['agreed'] },
  {
    body: { version: 2, text_sha256: 'b'.repeat(64), agreed: false },
    fields: ['version', 'text_sha256', 'agreed'],
  },
])(
  '[AC-B1-13h#8] 展示内容或主动同意不符 $fields 返回 20001，既有记录不变',
  async ({ body, fields }) => {
    const f = await fixture(kit);
    await history(kit, f, 1, '2026-10-17T00:00:00Z');
    const before = await f.rows();
    const response = await f.sign(body);
    expect(signed(kit, response, 20001).data?.['fields']).toEqual(expect.arrayContaining(fields));
    expect(await f.rows()).toEqual(before);
    privateDataAbsent(kit, [response]);
  },
);

it('[AC-B1-13h#9] 拉取全文后发布新版本，旧版本签署被拒绝，原幂等键可用于更正请求', async () => {
  const f = await fixture(kit);
  envelope(kit, await f.get(), 0);
  await config(kit, f.appId, {
    'legal.labor_agreement.version': 2,
    'legal.labor_agreement.resign_from_version': 2,
  });
  kit.clock.advanceMs(61_000);
  const key = randomUUID();
  expect(signed(kit, await f.sign(BODY, key), 20001).data?.['fields']).toContain('version');
  expect(await f.rows()).toEqual([]);
  signed(kit, await f.sign({ ...BODY, version: 2 }, key));
  expect(await f.rows()).toHaveLength(1);
});

const BAD_CONFIG = [
  ['legal.labor_agreement.version', 0],
  ['legal.labor_agreement.version', 1.5],
  ['legal.labor_agreement.version', '1'],
  ['legal.labor_agreement.text_url', 'not a URL'],
  ['legal.labor_agreement.text_sha256', 'A'.repeat(64)],
  ['legal.labor_agreement.text_sha256', 'a'.repeat(63)],
  ['legal.labor_agreement.resign_from_version', 0],
  ['legal.labor_agreement.resign_from_version', 1.5],
  ['legal.labor_agreement.resign_from_version', '1'],
  ['legal.operator_entity.name', ''],
  ['legal.operator_entity.credit_code', ''],
] as const;
const CONFIG_FAILURES = [
  ...Object.keys(CONFIG).map((key) => ({ key, missing: true, value: null as unknown })),
  ...BAD_CONFIG.map(([key, value]) => ({ key, missing: false, value })),
];
it.each(CONFIG_FAILURES)(
  '[AC-B1-13h#10] 配置 $key 缺失=$missing 值=$value 时封闭失败并只记配置键',
  async ({ key, missing, value }) => {
    const values: Record<string, unknown> = { ...CONFIG };
    if (missing) delete values[key];
    else values[key] = value;
    const f = await fixture(kit, { config: values });
    const responses = [];
    // GET needs only agreement metadata; operator identity is needed when actually signing.
    if (key.startsWith('legal.labor_agreement.')) {
      const response = await f.get();
      envelope(kit, response, 50001);
      responses.push(response);
    }
    const response = await f.sign();
    signed(kit, response, 50001);
    responses.push(response);
    expect(await f.rows()).toEqual([]);
    const warnings = kit.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['level'] === 40 && line['config_key'] === key);
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      const text = JSON.stringify(warning);
      for (const secret of [f.uid, f.deviceId, f.realnameId]) expect(text).not.toContain(secret);
    }
    privateDataAbsent(kit, responses);
  },
);

it.each(['read_only', 'standard'] as const)(
  '[AC-B1-13h#11] 真实 h5_token 的 %s 作用域对 GET 和签署均为 10403',
  async (scope) => {
    const f = await fixture(kit);
    const issued = await f.request('POST', '/v1/auth/h5-token', { scope });
    expect(issued.statusCode).toBe(200);
    const token = issued.json<{ data: { token: string } }>().data.token;
    envelope(kit, await f.request('GET', PATH, undefined, { token }), 10403);
    signed(kit, await f.request('POST', SIGN, BODY, { token }), 10403);
    expect(await f.rows()).toEqual([]);
  },
);

it('[AC-B1-13h#12] 未实名两条路由均由真实守卫返回 30304，不产生同意记录', async () => {
  const f = await fixture(kit, { verified: false });
  envelope(kit, await f.get(), 30304);
  signed(kit, await f.sign(), 30304);
  expect(await f.rows()).toEqual([]);
});

it('[AC-B1-13h#13] 未登录两条路由均拒绝，不允许只靠设备签名签署', async () => {
  const f = await fixture(kit);
  envelope(kit, await f.request('GET', PATH, undefined, { anonymous: true }), 10001);
  signed(kit, await f.request('POST', SIGN, BODY, { anonymous: true }), 10001);
  expect(await f.rows()).toEqual([]);
});

it('[AC-B1-13h#14] 签署与配置按 app/user 隔离，不借用其他人的签署', async () => {
  const owner = await fixture(kit);
  signed(kit, await owner.sign());
  const otherUser = await fixture(kit, { appId: owner.appId, idNo: '110105194912310011' });
  expect(envelope(kit, await otherUser.get(), 0).data).toMatchObject({
    need_sign: true,
    signed_version: null,
  });
  const otherApp = await fixture(kit, {
    config: {
      ...CONFIG,
      'legal.labor_agreement.version': 7,
      'legal.labor_agreement.resign_from_version': 7,
      'legal.labor_agreement.text_sha256': 'c'.repeat(64),
    },
  });
  expect(envelope(kit, await otherApp.get(), 0).data).toMatchObject({
    version: 7,
    text_sha256: 'c'.repeat(64),
    need_sign: true,
    signed_version: null,
  });
  signed(kit, await otherApp.sign({ version: 7, text_sha256: 'c'.repeat(64), agreed: true }));
  expect(envelope(kit, await owner.get(), 0).data).toMatchObject({
    version: 1,
    signed_version: 1,
    need_sign: false,
  });
  expect(await otherUser.rows()).toEqual([]);
  expect(await owner.rows()).toHaveLength(1);
});

it('[AC-B1-13h#15] identity 公共只读端口与 GET 一致，接受调用方事务且不产生写入', async () => {
  const f = await fixture(kit);
  const read = await port();
  const subject = { app_id: f.appId, user_id: f.uid };
  expect(await read.laborAgreementSigned(kit.db, subject)).toBe(false);
  expect(envelope(kit, await f.get(), 0).data?.['need_sign']).toBe(true);
  signed(kit, await f.sign());
  const before = await f.rows();
  await kit.db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    expect(await read.laborAgreementSigned(trx, subject)).toBe(true);
  });
  expect(envelope(kit, await f.get(), 0).data?.['need_sign']).toBe(false);
  const otherApp = await fixture(kit);
  expect(await read.laborAgreementSigned(kit.db, { ...subject, app_id: otherApp.appId })).toBe(
    false,
  );
  await config(kit, f.appId, { 'legal.labor_agreement.version': 2 });
  kit.clock.advanceMs(61_000);
  expect(await read.laborAgreementSigned(kit.db, subject)).toBe(true);
  expect(envelope(kit, await f.get(), 0).data?.['need_sign']).toBe(false);
  await config(kit, f.appId, { 'legal.labor_agreement.resign_from_version': 2 });
  kit.clock.advanceMs(61_000);
  expect(await read.laborAgreementSigned(kit.db, subject)).toBe(false);
  expect(envelope(kit, await f.get(), 0).data?.['need_sign']).toBe(true);
  expect(await f.rows()).toEqual(before);
});

it('[AC-B1-13h#16] 并发不同幂等键的成功签署各插一行，不覆盖已有签署', async () => {
  const f = await fixture(kit);
  await history(kit, f, 1, '2026-10-17T00:00:00Z');
  const before = (await f.rows())[0];
  const responses = await Promise.all([f.sign(), f.sign()]);
  for (const response of responses) signed(kit, response);
  const rows = await f.rows();
  expect(rows).toHaveLength(3);
  expect(rows[0]).toEqual(before);
  expect(new Set(rows.map((row) => row['id'])).size).toBe(3);
});

it('[AC-B1-13h#17] 只读端口能看到调用方未提交的签署，不能另开连接读取', async () => {
  const f = await fixture(kit);
  const read = await port();
  const subject = { app_id: f.appId, user_id: f.uid };
  expect(await read.laborAgreementSigned(kit.db, subject)).toBe(false);
  await kit.db.transaction().execute(async (trx) => {
    await sql`INSERT INTO app.consent_records (app_id, subject_type, user_id, device_id, type, version, accepted, channel, text_sha256, signer_snapshot, client_at, server_at, created_at)
      VALUES (${f.appId}, 'user', ${f.uid}, ${f.deviceId}, 'labor_agreement', 1, true, 'withdraw_flow', ${SHA}, ${JSON.stringify({ platform: { name: CONFIG['legal.operator_entity.name'], credit_code: CONFIG['legal.operator_entity.credit_code'] }, user: { user_id: f.uid, realname_id: f.realnameId, masked_name: '***明' } })}::jsonb, ${kit.clock.now()}, ${kit.clock.now()}, ${kit.clock.now()})`.execute(
      trx,
    );
    expect(await read.laborAgreementSigned(trx, subject)).toBe(true);
  });
  expect(envelope(kit, await f.get(), 0).data?.['need_sign']).toBe(false);
  expect(await f.rows()).toHaveLength(1);
});
