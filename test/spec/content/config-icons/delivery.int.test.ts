// Scope: task F1-02d §9.1–9.3 (08 BR-TEXT-24 细则「发布与回滚」「客户端显示」, contract
// Config.platform_icons / ConfigPlatformIcons / ConfigPlatformIcon). Every case uses its own
// app_id; content is observed only through GET /v1/config. The reader clock is never advanced:
// platform marks must not be cached (§9.2 #3).
import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  REQUIRED,
  config,
  configured,
  delivered,
  harness,
  icons,
  read,
  saveVersion,
  session,
  setCurrent,
  validate,
  warned,
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

it('[AC-F1-02d#1] 没有任何平台标识行时 platform_icons 为空对象，响应过 ConfigResponse 契约', async () => {
  const a = await configured(h);
  expect(await icons(h.app, a.id)).toEqual({});
});

it('[AC-F1-02d#2] 只有草稿版本（从未发布）的键不下发', async () => {
  const a = await configured(h);
  await saveVersion(h, a, 'taobao', 1);
  await saveVersion(h, a, 'jd', 1);
  await setCurrent(h, a, 'jd', null);
  expect(await icons(h.app, a.id)).toEqual({});
});

it('[AC-F1-02d#3] 单键已发布：值为 {url, sha256, version}，url 为去尾斜杠的媒体基址 + 摘要 + .svg', async () => {
  const a = await configured(h);
  const v1 = await saveVersion(h, a, 'alipay', 1);
  await setCurrent(h, a, 'alipay', 1);
  const result = await icons(h.app, a.id);
  expect(result).toEqual({ alipay: delivered(v1) });
  expect(result!.alipay!.url).toBe(`https://icons.example.invalid/media/${v1.sha256}.svg`);
});

it('[AC-F1-02d#4] 多键只列已发布的键；值取 current_version 而不是最新保存的版本；png 后缀为 .png', async () => {
  const a = await configured(h);
  await saveVersion(h, a, 'taobao', 1);
  const taobao2 = await saveVersion(h, a, 'taobao', 2);
  await setCurrent(h, a, 'taobao', 2);
  // pdd: published v1, then a newer v2 and v3 saved as drafts (latest_version 3, current 1).
  const pdd1 = await saveVersion(h, a, 'pdd', 1);
  await setCurrent(h, a, 'pdd', 1);
  await saveVersion(h, a, 'pdd', 2);
  await saveVersion(h, a, 'pdd', 3);
  const wecom = await saveVersion(h, a, 'wecom', 1, 'png');
  await setCurrent(h, a, 'wecom', 1);
  // jd: drafts only; wechat_pay: no rows at all.
  await saveVersion(h, a, 'jd', 1);
  await saveVersion(h, a, 'jd', 2);
  const result = await icons(h.app, a.id);
  expect(result).toEqual({
    taobao: delivered(taobao2),
    pdd: delivered(pdd1),
    wecom: delivered(wecom),
  });
  expect(result!.wecom!.url).toBe(`https://icons.example.invalid/media/${wecom.sha256}.png`);
  expect(result!.pdd!.version).toBe(1);
});

it('[AC-F1-02d#5] 发布后下一次请求立即可见，无需推进时钟（不缓存，即使上一次请求已读过配置）', async () => {
  const a = await configured(h);
  expect(await icons(h.app, a.id)).toEqual({});
  const v1 = await saveVersion(h, a, 'tmall', 1);
  await setCurrent(h, a, 'tmall', 1);
  expect(await icons(h.app, a.id)).toEqual({ tmall: delivered(v1) });
});

it('[AC-F1-02d#6] 回滚后立即下发回滚到的版本，url 与 sha256 随之变化', async () => {
  const a = await configured(h);
  const v1 = await saveVersion(h, a, 'wechat', 1);
  const v2 = await saveVersion(h, a, 'wechat', 2, 'png');
  await setCurrent(h, a, 'wechat', 1);
  await setCurrent(h, a, 'wechat', 2);
  expect(await icons(h.app, a.id)).toEqual({ wechat: delivered(v2) });
  await setCurrent(h, a, 'wechat', 1);
  const result = await icons(h.app, a.id);
  expect(result).toEqual({ wechat: delivered(v1) });
  expect(result!.wechat!.url).not.toBe(delivered(v2).url);
});

it('[AC-F1-02d#7] 「恢复内置」后该键立即从下发里消失，其余已发布键不受影响', async () => {
  const a = await configured(h);
  const alipay = await saveVersion(h, a, 'alipay', 1);
  const pay = await saveVersion(h, a, 'wechat_pay', 1);
  await setCurrent(h, a, 'alipay', 1);
  await setCurrent(h, a, 'wechat_pay', 1);
  expect(await icons(h.app, a.id)).toEqual({
    alipay: delivered(alipay),
    wechat_pay: delivered(pay),
  });
  await setCurrent(h, a, 'alipay', null);
  const result = await icons(h.app, a.id);
  expect(result).toEqual({ wechat_pay: delivered(pay) });
  expect(Object.hasOwn(result!, 'alipay')).toBe(false);
});

it('[AC-F1-02d#8] 标识表里不属于 PlatformIconKey 的键即使已发布也不下发', async () => {
  const a = await configured(h);
  await saveVersion(h, a, 'meituan', 1);
  await setCurrent(h, a, 'meituan', 1);
  const jd = await saveVersion(h, a, 'jd', 1);
  await setCurrent(h, a, 'jd', 1);
  expect(await icons(h.app, a.id)).toEqual({ jd: delivered(jd) });
});

it('[AC-F1-02d#9] 跨 app 隔离：每个 app 只看到自己已发布的标识', async () => {
  const a = await configured(h);
  const b = await configured(h);
  const c = await configured(h);
  const aTaobao = await saveVersion(h, a, 'taobao', 1);
  await setCurrent(h, a, 'taobao', 1);
  await saveVersion(h, b, 'taobao', 1);
  const bTaobao2 = await saveVersion(h, b, 'taobao', 2);
  await setCurrent(h, b, 'taobao', 2);
  const bJd = await saveVersion(h, b, 'jd', 1);
  await setCurrent(h, b, 'jd', 1);
  expect(aTaobao.sha256).not.toBe(bTaobao2.sha256);
  expect(await icons(h.app, a.id)).toEqual({ taobao: delivered(aTaobao) });
  expect(await icons(h.app, b.id)).toEqual({ taobao: delivered(bTaobao2), jd: delivered(bJd) });
  expect(await icons(h.app, c.id)).toEqual({});
});

it('[AC-F1-02d#10] 游客、登录、deletion_only 会话下发同一份 platform_icons', async () => {
  const a = await configured(h);
  const v1 = await saveVersion(h, a, 'jd', 1, 'png');
  await setCurrent(h, a, 'jd', 1);
  const expected = { jd: delivered(v1) };
  expect(await icons(h.app, a.id)).toEqual(expected);
  expect(await icons(h.app, a.id, await session(h, a.id, 'full'))).toEqual(expected);
  expect(await icons(h.app, a.id, await session(h, a.id, 'deletion_only'))).toEqual(expected);
});

it('[AC-F1-02d#11] 未配 MEDIA_PUBLIC_BASE_URL：省略 platform_icons 键并记 warn（带 app_id），其余配置照常 200', async () => {
  const unset = await h.start('unset');
  const a = await configured(h);
  await saveVersion(h, a, 'taobao', 1);
  await setCurrent(h, a, 'taobao', 1);
  const response = await read(unset, a.id);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    data: { h5_base_url: REQUIRED['h5_base_url'], kf: REQUIRED['kf'] },
  });
  await validate(response);
  const data = response.json<{ data: Record<string, unknown> }>().data;
  expect(Object.hasOwn(data, 'platform_icons')).toBe(false);
  expect(warned(h.logs, a.id), '应记一条带 app_id 的 warn 日志').toBe(true);
});

it('[AC-F1-02d#12] 已配基址时其余配置键照常下发，platform_icons 只是在其上增加的键', async () => {
  const a = await configured(h);
  const data = await config(h.app, a.id);
  expect(data).toMatchObject({
    h5_base_url: REQUIRED['h5_base_url'],
    kf: REQUIRED['kf'],
    h5_release: { version: 'stable-v1' },
    legal: { privacy: { version: 7, min_version: 3 }, agreement: { version: 5 } },
    platform_icons: {},
  });
});
