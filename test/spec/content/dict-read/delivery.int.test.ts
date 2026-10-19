// F1-02s §9.2/9.3. All data observations go through real api HTTP + DictResponse validation.
// Each case has an independent app_id; no deletes, no fixtures from other tasks.
// Snapshot isolation during concurrent publication is additionally a code-review obligation:
// version and rows must come from one SQL statement or one repeatable-read snapshot.
import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  NOW,
  PATH,
  appId,
  configRequired,
  configValue,
  harness,
  read,
  seedRows,
  success,
  validate,
  type Harness,
} from './kit.ts';

let database: Awaited<ReturnType<(typeof import('@couli/db/testing'))['createTestDatabase']>>;
let redis: Awaited<ReturnType<(typeof import('@couli/db/testing'))['acquireTestRedis']>>;
let db: ReturnType<typeof createDb>;
let h: Harness;
beforeAll(async () => {
  const testing = await import('@couli/db/testing');
  database = await testing.createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  redis = await testing.acquireTestRedis();
  h = await harness(db, database.urlFor('couli_app'), redis.url);
}, 180_000);
beforeEach(() => {
  h.clock.set(NOW);
});
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
});

it('[AC-F1-02s#5] 无 dict_version 且无字典行：匿名返回 0 与空 items', async () => {
  expect(await success(await read(h.app, appId()))).toEqual({ version: '0', items: {} });
});

it('[AC-F1-02s#6] 有未发布的字典行、缺 dict_version 时仍回空字典', async () => {
  const id = appId();
  await seedRows(db, id, [{ dict: 'ai_label', code: '', version: 1, text: '尚未发布' }]);
  expect(await success(await read(h.app, id))).toEqual({ version: '0', items: {} });
});

it('[AC-F1-02s#7] 显式 0 哨兵不会从已有字典行推导版本', async () => {
  const id = appId();
  await configValue(db, id, 'dict_version', '0');
  await seedRows(db, id, [{ dict: 'ai_label', code: '', version: 3, text: '不能下发' }]);
  expect(await success(await read(h.app, id))).toEqual({ version: '0', items: {} });
});

it('[AC-F1-02s#8] 每个键取 version ≤ 3 的最大行，不能取全局最大或仅 version = 3', async () => {
  const id = appId();
  await configValue(db, id, 'dict_version', '3');
  await seedRows(db, id, [
    { dict: 'order_status', code: 'CREDITED.summary', version: 1, text: '第一版' },
    { dict: 'order_status', code: 'CREDITED.summary', version: 4, text: '未来版' },
    { dict: 'order_status', code: 'CREDITED.summary', version: 3, text: '已到账' },
    { dict: 'order_status', code: 'PENDING', version: 2, text: '处理中' },
    { dict: 'order_status_group', code: 'credited', version: 1, text: '已结算' },
    { dict: 'order_status_group', code: 'credited', version: 4, text: null },
    { dict: 'future', code: 'only', version: 4, text: '未来才出现' },
  ]);
  expect(await success(await read(h.app, id))).toEqual({
    version: '3',
    items: {
      order_status: { 'CREDITED.summary': '已到账', PENDING: '处理中' },
      order_status_group: { credited: '已结算' },
    },
  });
});

it('[AC-F1-02s#9] 多点 code 与无点键的空 code 原样下发，空文本也是有效值', async () => {
  const id = appId();
  await configValue(db, id, 'dict_version', '2');
  await seedRows(db, id, [
    { dict: 'order_status', code: 'CREDITED.summary', version: 2, text: '到账文案' },
    { dict: 'ai_label', code: '', version: 1, text: '智能助手' },
    { dict: 'ai_label', code: 'empty', version: 2, text: '' },
  ]);
  expect(await success(await read(h.app, id))).toEqual({
    version: '2',
    items: {
      order_status: { 'CREDITED.summary': '到账文案' },
      ai_label: { '': '智能助手', empty: '' },
    },
  });
});

it('[AC-F1-02s#10] 当前行 text = null 不下发该键，也不回落到较早的非 null 行', async () => {
  const id = appId();
  await configValue(db, id, 'dict_version', '2');
  await seedRows(db, id, [
    { dict: 'order_status', code: 'CREDITED.summary', version: 1, text: '旧文案' },
    { dict: 'order_status', code: 'CREDITED.summary', version: 2, text: null },
    { dict: 'order_status', code: 'CREDITED.summary', version: 3, text: '未来恢复' },
    { dict: 'order_status', code: 'PENDING', version: 1, text: '等待中' },
    { dict: 'ai_label', code: '', version: 1, text: null },
  ]);
  const data = await success(await read(h.app, id));
  expect(data.version).toBe('2');
  expect(data.items['order_status']).toEqual({ PENDING: '等待中' });
  expect(data.items['ai_label'] ?? {}).toEqual({});
});

it.each([
  [12, '0'],
  [null, '0'],
  ['dict-42', 'dict-42'],
] as const)(
  '[AC-F1-02s#11] 配置 %j 下 dict.version 与同库 config.dict_version 一致且 items 空',
  async (value, version) => {
    const id = appId();
    await configRequired(db, id);
    await configValue(db, id, 'dict_version', value);
    await seedRows(db, id, [{ dict: 'ai_label', code: '', version: 1, text: '不能下发' }]);
    const data = await success(await read(h.app, id));
    expect(data).toEqual({ version, items: {} });
    const config = await read(h.app, id, '/v1/config');
    expect(config.statusCode).toBe(200);
    await validate(config, '/v1/config');
    expect(config.json<{ data: { dict_version: string } }>().data.dict_version).toBe(data.version);
  },
);

it.each(['dict-42', '01', '-1', '1.0', '1e2', '2147483648', '10000000000'])(
  '[AC-F1-02s#12] 非法整数版本 %s 原样回、items 空并记 warn',
  async (version) => {
    const id = appId();
    await configValue(db, id, 'dict_version', version);
    await seedRows(db, id, [{ dict: 'ai_label', code: '', version: 1, text: '不能下发' }]);
    const start = h.logs.length;
    expect(await success(await read(h.app, id))).toEqual({ version, items: {} });
    expect(
      h.logs
        .slice(start)
        .map((line) => JSON.parse(line) as { level: number })
        .some((entry) => entry.level === 40),
    ).toBe(true);
  },
);

it('[AC-F1-02s#13] int32 上限可读、版本按数值比较而非字典序', async () => {
  const id = appId();
  await configValue(db, id, 'dict_version', '2147483647');
  await seedRows(db, id, [
    { dict: 'ai_label', code: '', version: 9, text: '九' },
    { dict: 'ai_label', code: '', version: 10, text: '十' },
    { dict: 'ai_label', code: '', version: 2_147_483_647, text: '上限' },
  ]);
  expect(await success(await read(h.app, id))).toEqual({
    version: '2147483647',
    items: { ai_label: { '': '上限' } },
  });
});

it('[AC-F1-02s#14] version 参数缺省、等于当前或旧版本均返回全量，不回 304', async () => {
  const id = appId();
  await configValue(db, id, 'dict_version', '3');
  await seedRows(db, id, [{ dict: 'ai_label', code: '', version: 2, text: '全量' }]);
  for (const suffix of ['', '?version=3', '?version=1', '?version=99']) {
    expect(await success(await read(h.app, id, `${PATH}${suffix}`))).toEqual({
      version: '3',
      items: { ai_label: { '': '全量' } },
    });
  }
});

it('[AC-F1-02s#15] 匿名不要求令牌或设备，deletion_only 以及无效令牌也不被读取', async () => {
  const id = appId();
  await configValue(db, id, 'dict_version', '1');
  await seedRows(db, id, [{ dict: 'ai_label', code: '', version: 1, text: '公开文案' }]);
  for (const authorization of [undefined, `Bearer ${h.restrictedToken(id)}`, 'Bearer invalid']) {
    const extra = authorization === undefined ? {} : { authorization };
    expect(await success(await read(h.app, id, PATH, extra))).toEqual({
      version: '1',
      items: { ai_label: { '': '公开文案' } },
    });
  }
});

it('[AC-F1-02s#16] 缓存 version 与 items 一起保留 60 秒，version 提示不进缓存键也不续期', async () => {
  const id = appId();
  await configValue(db, id, 'dict_version', '1');
  await seedRows(db, id, [{ dict: 'ai_label', code: '', version: 1, text: '旧内容' }]);
  const old = { version: '1', items: { ai_label: { '': '旧内容' } } };
  expect(await success(await read(h.app, id))).toEqual(old);
  await seedRows(db, id, [{ dict: 'ai_label', code: '', version: 2, text: '新内容' }]);
  await configValue(db, id, 'dict_version', '2');
  h.clock.advanceMs(59_999);
  for (const suffix of ['', '?version=1', '?version=0']) {
    expect(await success(await read(h.app, id, `${PATH}${suffix}`))).toEqual(old);
  }
  h.clock.advanceMs(1);
  expect(await success(await read(h.app, id, `${PATH}?version=1`))).toEqual({
    version: '2',
    items: { ai_label: { '': '新内容' } },
  });
});

it('[AC-F1-02s#17] 两个 app 同版本同键不串缓存或行，config 版本也按 app 隔离', async () => {
  const a = appId();
  const b = appId();
  const c = appId();
  for (const id of [a, b]) await configValue(db, id, 'dict_version', '2');
  await configValue(db, c, 'dict_version', '4');
  await seedRows(db, a, [{ dict: 'ai_label', code: '', version: 2, text: '甲' }]);
  await seedRows(db, b, [
    { dict: 'ai_label', code: '', version: 2, text: '乙' },
    { dict: 'private_label', code: 'b', version: 1, text: '仅乙' },
  ]);
  await seedRows(db, c, [{ dict: 'ai_label', code: '', version: 4, text: '丙' }]);
  const expectedA = { version: '2', items: { ai_label: { '': '甲' } } };
  expect(await success(await read(h.app, a))).toEqual(expectedA);
  expect(await success(await read(h.app, b))).toEqual({
    version: '2',
    items: { ai_label: { '': '乙' }, private_label: { b: '仅乙' } },
  });
  expect(await success(await read(h.app, c))).toEqual({
    version: '4',
    items: { ai_label: { '': '丙' } },
  });
  expect(await success(await read(h.app, a))).toEqual(expectedA);
});

it('[AC-F1-02s#18] 无库句柄仍注册路由，请求返回 50001 而不是成功空字典', async () => {
  const app = await h.start(null);
  expect(app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: PATH })).toBe(true);
  const response = await read(app, appId());
  expect(response.statusCode).toBe(500);
  expect(response.json()).toMatchObject({ code: 50001 });
  await validate(response);
});

it('[AC-F1-02s#21] 未发布的空结果也缓存，到期后可读首个发布版本', async () => {
  const id = appId();
  const unpublished = { version: '0', items: {} };
  expect(await success(await read(h.app, id))).toEqual(unpublished);
  await seedRows(db, id, [{ dict: 'ai_label', code: '', version: 1, text: '首版' }]);
  await configValue(db, id, 'dict_version', '1');
  h.clock.advanceMs(59_999);
  expect(await success(await read(h.app, id))).toEqual(unpublished);
  h.clock.advanceMs(1);
  expect(await success(await read(h.app, id))).toEqual({
    version: '1',
    items: { ai_label: { '': '首版' } },
  });
});

it('[AC-F1-02s#22] 合法发布版本没有对应行时保留版本并返回空 items', async () => {
  const id = appId();
  await configValue(db, id, 'dict_version', '5');
  expect(await success(await read(h.app, id))).toEqual({ version: '5', items: {} });
});

it.each(['', 'x'.repeat(33)])(
  '[AC-F1-02s#19] 查询 version 长度不合法 %j 返回契约参数错误',
  async (version) => {
    const response = await read(h.app, appId(), `${PATH}?version=${version}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001 });
    await validate(response);
  },
);
