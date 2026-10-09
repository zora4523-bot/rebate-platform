// BR-ID-09 and BR-ID-05 excerpts in B1-02c; registerDevice contract, 04 §3.2 / §6.1.
// Real HTTP injection and per-file migrated database clone; no mocked identity implementation.
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConnectionConfig } from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  buildApp,
  countDevices,
  deviceRows,
  headers,
  makeDir,
  register,
  responseValidator,
  validCase,
  vectors,
  type HttpApp,
  type Response,
} from './kit.ts';

let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB>;
let app: HttpApp | undefined;
let dir: string | undefined;
let validate: Awaited<ReturnType<typeof responseValidator>>['validate'];
let validateError: Awaited<ReturnType<typeof responseValidator>>['validateError'];
const lines: string[] = [];
const issuedSecrets = new Set<string>();

beforeAll(async () => {
  ({ validate, validateError } = await responseValidator());
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  dir = makeDir();
  redis = await acquireTestRedis();
  app = await buildApp(
    db,
    dir,
    lines,
    loadConnectionConfig('api', {
      DATABASE_URL: database.urlFor('couli_app'),
      REDIS_URL: redis.url,
    }).redisUrl,
  );
  await app.init();
});

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
      await redis?.stop();
    } finally {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  }
});

function success(response: Response, label = '') {
  expect(response.statusCode, label).toBe(200);
  const body = response.json<{
    code: number;
    data: { device_id: string; install_secret: string };
  }>();
  const valid = validate(body);
  expect(validate.errors ?? [], label).toEqual([]);
  expect(valid, label).toBe(true);
  expect(body.code).toBe(0);
  expect(body.data.device_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(body.data.install_secret.length).toBeGreaterThan(0);
  issuedSecrets.add(body.data.install_secret);
  return body.data;
}

async function rejected(payload: Record<string, unknown>, field: string, label: string) {
  const before = await countDevices(db);
  const response = await register(app!, payload);
  expect(response.statusCode, label).toBe(400);
  const body = response.json<{ code: number; data?: Record<string, unknown> }>();
  const valid = validateError(body);
  expect(validateError.errors ?? [], label).toEqual([]);
  expect(valid, label).toBe(true);
  expect(body.code, label).toBe(20001);
  expect(body.data?.['fields'], label).toEqual([field]);
  expect(body.data, label).not.toHaveProperty('device_id');
  expect(body.data, label).not.toHaveProperty('install_secret');
  expect(await countDevices(db), label).toBe(before);
}

it('[AC-B1-02c#1][BR-ID-09 细则；registerDevice] 全部有效向量及随机合法哈希无需签名或登录即可注册，响应符合契约', async () => {
  expect(vectors.hash_cases.length).toBeGreaterThan(0);
  for (const vector of vectors.hash_cases) {
    success(
      await register(
        app!,
        {
          device_hash: vector.device_hash,
          id_source: vector.id_source,
        },
        headers(vector.id_source),
      ),
      vector.note,
    );
  }
  success(
    await register(
      app!,
      {
        device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
        id_source: 'android_id',
      },
      headers('android_id'),
    ),
    '随机合法哈希也可注册，无效清单不能变成向量白名单',
  );
});

it('[AC-B1-02c#2][BR-ID-09；04 §3.2 devices] 注册新增一行，保存请求头、哈希、来源与未绑定未吊销状态', async () => {
  for (const [index, vector] of vectors.hash_cases.entries()) {
    const before = await countDevices(db);
    const requestHeaders = headers(vector.id_source, 'couli', `2.${index}.0`);
    const data = success(
      await register(
        app!,
        {
          device_hash: vector.device_hash,
          id_source: vector.id_source,
        },
        requestHeaders,
      ),
    );
    const rows = (await deviceRows(db, vector.device_hash)).filter(
      (row) => row.id === data.device_id,
    );
    expect(await countDevices(db)).toBe(before + 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: data.device_id,
      app_id: requestHeaders['x-app-id'],
      device_hash: vector.device_hash,
      id_source: vector.id_source,
      platform: requestHeaders['x-platform'],
      app_version: requestHeaders['x-app-version'],
      user_id: null,
      revoked_at: null,
    });
    expect(Buffer.isBuffer(rows[0]!.install_secret_cipher)).toBe(true);
    expect(rows[0]!.install_secret_cipher.length).toBeGreaterThan(0);
  }
});

it('[AC-B1-02c#3][BR-ID-09；04 §3.2 devices] install_secret 原串、解码字节及其 hex/base64/base64url 写法不落库', async () => {
  const vector = validCase();
  const data = success(
    await register(app!, { device_hash: vector.device_hash, id_source: vector.id_source }),
  );
  const rows = (await deviceRows(db, vector.device_hash)).filter(
    (row) => row.id === data.device_id,
  );
  expect(rows).toHaveLength(1);
  const secret = Buffer.from(data.install_secret, 'utf8');
  const rawForms = [secret];
  if (/^(?:[0-9a-fA-F]{2})+$/.test(data.install_secret))
    rawForms.push(Buffer.from(data.install_secret, 'hex'));
  for (const encoding of ['base64url', 'base64'] as const) {
    const alphabet = encoding === 'base64url' ? /^[A-Za-z0-9_-]+={0,2}$/ : /^[A-Za-z0-9+/]+={0,2}$/;
    if (!alphabet.test(data.install_secret)) continue;
    const decoded = Buffer.from(data.install_secret, encoding);
    // Buffer decoding is permissive; round-trip to exclude malformed encodings.
    if (decoded.toString(encoding).replace(/=+$/, '') === data.install_secret.replace(/=+$/, ''))
      rawForms.push(decoded);
  }
  const forms = rawForms
    .flatMap((bytes) => [
      bytes,
      Buffer.from(bytes.toString('hex')),
      Buffer.from(bytes.toString('base64')),
      Buffer.from(bytes.toString('base64url')),
    ])
    .filter((bytes) => bytes.length >= 12);
  expect(Buffer.isBuffer(rows[0]!.install_secret_cipher)).toBe(true);
  expect(rows[0]!.install_secret_cipher.length).toBeGreaterThan(0);
  for (const [column, value] of Object.entries(rows[0]!)) {
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(typeof value === 'bigint' ? String(value) : (JSON.stringify(value) ?? ''));
    for (const form of forms) expect(bytes.includes(form), `列 ${column} 不含原值`).toBe(false);
  }
});

it('[AC-B1-02c#4][BR-ID-09 细则] 大写、63位、65位、非hex、空串均返回20001且不签发不落库', async () => {
  const hash = validCase().device_hash;
  for (const [label, device_hash] of [
    ['大写', hash.toUpperCase()],
    ['63位', hash.slice(1)],
    ['65位', `${hash}a`],
    ['非hex', `g${hash.slice(1)}`],
    ['空串', ''],
  ] as const)
    await rejected({ device_hash, id_source: 'idfv' }, 'device_hash', label);
});

it('[AC-B1-02c#5][BR-ID-09 细则] 无效哈希清单的每个种子均返回20001且不签发不落库', async () => {
  expect(vectors.invalid_hash_seeds.length).toBeGreaterThan(0);
  for (const seed of vectors.invalid_hash_seeds) {
    await rejected({ device_hash: seed.device_hash, id_source: 'idfv' }, 'device_hash', seed.note);
  }
});

it('[AC-B1-02c#6][BR-ID-09 细则；registerDevice] id_source 缺失或枚举外值返回20001且不落库', async () => {
  const device_hash = validCase().device_hash;
  await rejected({ device_hash }, 'id_source', '缺失');
  for (const id_source of ['unknown', 'IDFV', '', null, 7]) {
    await rejected({ device_hash, id_source }, 'id_source', `非法来源 ${String(id_source)}`);
  }
});

it('[AC-B1-02c#7][BR-ID-05 细则；BR-ID-09] 同设备复注册签发不同ID与密钥，两行哈希相同且均未吊销', async () => {
  const vector = validCase();
  const payload = { device_hash: vector.device_hash, id_source: vector.id_source };
  const before = await countDevices(db);
  const first = success(await register(app!, payload));
  const second = success(await register(app!, payload));
  expect(second.device_id).not.toBe(first.device_id);
  expect(second.install_secret).not.toBe(first.install_secret);
  expect(await countDevices(db)).toBe(before + 2);
  const ids = [first.device_id, second.device_id];
  const rows = (await deviceRows(db, vector.device_hash)).filter((row) => ids.includes(row.id));
  expect(rows.map((row) => row.id).sort()).toEqual(ids.sort());
  for (const row of rows)
    expect(row).toMatchObject({ device_hash: vector.device_hash, revoked_at: null });
});

it('[AC-B1-02c#8][04 §3.2 devices；registerDevice] 同哈希在两个App注册，各新增一行且app_id来自各自请求头', async () => {
  const vector = validCase();
  const before = await countDevices(db);
  const issued: { id: string; app_id: string }[] = [];
  for (const appId of ['couli', 'couli_other']) {
    const data = success(
      await register(
        app!,
        {
          device_hash: vector.device_hash,
          id_source: vector.id_source,
        },
        headers(vector.id_source, appId),
      ),
    );
    issued.push({ id: data.device_id, app_id: appId });
  }
  expect(await countDevices(db)).toBe(before + 2);
  expect(new Set(issued.map((row) => row.id)).size).toBe(2);
  const rows = await deviceRows(db, vector.device_hash);
  for (const expected of issued) {
    const matching = rows.filter((row) => row.id === expected.id);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ ...expected, device_hash: vector.device_hash });
  }
});

it('[AC-B1-02c#9][BR-ID-09 install_secret；任务§9] 全部采集日志不泄露本文件签发的密钥原串及hex/base64写法', async () => {
  const vector = validCase();
  const start = lines.length;
  success(await register(app!, { device_hash: vector.device_hash, id_source: vector.id_source }));
  // Let the HTTP completion log finish before inspecting the synchronous memory destination.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(lines.length, '必须确实采集到请求日志').toBeGreaterThan(start);
  expect(issuedSecrets.size, '必须确实收集到签发的密钥').toBeGreaterThan(0);
  const captured = lines.join('');
  for (const secret of issuedSecrets) {
    expect(captured).not.toContain(secret);
    expect(captured).not.toContain(Buffer.from(secret).toString('hex'));
    expect(captured).not.toContain(Buffer.from(secret).toString('base64'));
  }
});
