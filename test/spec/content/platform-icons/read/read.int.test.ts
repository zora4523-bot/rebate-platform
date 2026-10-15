import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seed } from '../../../admin/accounts/kit.ts';
import { signedIn, useHarness } from '../../../admin/auth/kit.ts';
import {
  builtin,
  history,
  icon,
  KEYS,
  list,
  normalizedIcon,
  normalizedVersion,
  setup,
  UPDATED,
  version,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-06w#1] 无行的八个键按枚举顺序返回内置态，列表不分页', async () => {
  const f = await setup(h);
  expect(await list(f)).toEqual(KEYS.map(builtin));
});

it('[AC-F1-06w#2] 草稿、当前发布、回滚、恢复内置分别保留最新保存号和各自 revision', async () => {
  const f = await setup(h);
  // Insert in reverse enum order; current revision must not be confused with version revision.
  const restored = await version(h, f.actor, 'wecom', 1, {
    ever_published: true,
    source_url: 'https://source.example.invalid/wecom',
    downloaded_on: '2026-09-30',
  });
  await icon(h, f.actor, 'wecom', null, 9);
  const published = await version(h, f.actor, 'jd', 2, {
    format: 'png',
    sanitized: false,
    revision: 3,
    bytes: 9876,
    source_url: 'https://source.example.invalid/jd',
    downloaded_on: '2026-10-01',
    ever_published: true,
  });
  await version(h, f.actor, 'jd', 3); // Newer saved draft must not become current.
  await version(h, f.actor, 'jd', 1, { ever_published: true });
  await icon(h, f.actor, 'jd', 2, 8);
  await version(h, f.actor, 'taobao', 1);
  await icon(h, f.actor, 'taobao', null);
  const actual = (await list(f)).map(normalizedIcon);
  const metadata = { updated_by: 'last-editor-snapshot', updated_at: UPDATED };
  expect(actual).toEqual(
    KEYS.map((key) => {
      if (key === 'taobao') return { ...builtin(key), ...metadata, latest_version: 1 };
      if (key === 'jd')
        return {
          ...builtin(key),
          ...metadata,
          current_version: 2,
          current: published,
          latest_version: 3,
          revision: 8,
        };
      if (key === 'wecom') return { ...builtin(key), ...metadata, latest_version: 1, revision: 9 };
      return builtin(key);
    }),
  );
  expect((await history(f, 'wecom')).items.map(normalizedVersion)).toEqual([restored]);
});

it('[AC-F1-06w#3] 历史按版本号降序，包含所有草稿，publishable 必须同时有来源和日期', async () => {
  const f = await setup(h);
  const both = await version(h, f.actor, 'tmall', 2, {
    source_url: 'https://source.example.invalid/2',
    downloaded_on: '2026-10-01',
    created_at: '2026-10-07T00:00:00.000Z',
    revision: 7,
  });
  const neither = await version(h, f.actor, 'tmall', 4, { created_at: '2026-10-01T00:00:00.000Z' });
  const dateOnly = await version(h, f.actor, 'tmall', 1, { downloaded_on: '2026-09-30' });
  const sourceOnly = await version(h, f.actor, 'tmall', 3, {
    source_url: 'https://source.example.invalid/3',
  });
  await icon(h, f.actor, 'tmall', null);
  const result = await history(f, 'tmall');
  expect(result).toMatchObject({ page: 1, page_size: 20, total: 4 });
  expect(result.items.map(normalizedVersion)).toEqual([neither, sourceOnly, both, dateOnly]);
  expect(result.items.map((item) => item.publishable)).toEqual([false, false, true, false]);
  expect(result.items.map((item) => item.ever_published)).toEqual([false, false, false, false]);
  expect((await list(f)).find((item) => item.key === 'tmall')).toMatchObject({
    current: null,
    latest_version: 4,
  });
});

it('[AC-F1-06w#4] 默认 20 条、上限 200、单条分页和末页都保持完整 total', async () => {
  const f = await setup(h);
  // 201 rows distinguish the cap from an ignored page_size and exercise the last partial page.
  for (let n = 1; n <= 201; n += 1) await version(h, f.actor, 'pdd', n);
  await icon(h, f.actor, 'pdd', null);
  const numbers = Array.from({ length: 201 }, (_, index) => 201 - index);
  for (const [query, page, size, expected] of [
    ['', 1, 20, numbers.slice(0, 20)],
    ['?page=2', 2, 20, numbers.slice(20, 40)],
    ['?page_size=200', 1, 200, numbers.slice(0, 200)],
    ['?page=2&page_size=200', 2, 200, [1]],
    ['?page=3&page_size=200', 3, 200, []],
    ['?page=2&page_size=1', 2, 1, [200]],
  ] as const) {
    const result = await history(f, 'pdd', query);
    expect(result).toMatchObject({ page, page_size: size, total: 201 });
    expect(result.items.map((item) => item.version)).toEqual(expected);
  }
});

it('[AC-F1-06w#5] 没有保存版本时返回空页；未保存的上传不计入历史或 latest_version', async () => {
  const f = await setup(h);
  await h.db
    .insertInto('platform_icon_uploads')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      key: 'alipay',
      sha256: 'a'.repeat(64),
      format: 'svg',
      bytes: 19,
      sanitized: false,
      created_by_admin_id: f.actor.id,
      created_at: '2026-10-01T00:00:00.000Z',
      expires_at: '2026-10-02T00:00:00.000Z',
    })
    .execute();
  expect(await history(f, 'alipay')).toEqual({ items: [], total: 0, page: 1, page_size: 20 });
  expect(await history(f, 'wechat', '?page=3&page_size=200')).toEqual({
    items: [],
    total: 0,
    page: 3,
    page_size: 200,
  });
  expect(await list(f)).toEqual(KEYS.map(builtin));
});

it('[AC-F1-06w#6] 列表、current、latest 和历史计数都按令牌 app_id 隔离，也按 key 隔离', async () => {
  const f = await setup(h);
  const other = await seed(h, `other-${randomUUID()}`, { isSuper: true });
  const own = await version(h, f.actor, 'taobao', 1, { ever_published: true });
  await icon(h, f.actor, 'taobao', 1, 2);
  const foreign = await version(h, other, 'taobao', 1, { format: 'png', ever_published: true });
  await version(h, other, 'taobao', 99);
  await icon(h, other, 'taobao', 1, 7);
  await version(h, other, 'wechat_pay', 5, { ever_published: true });
  await icon(h, other, 'wechat_pay', 5, 10);
  await version(h, f.actor, 'jd', 88);
  await icon(h, f.actor, 'jd', null);
  const ownList = (await list(f)).map(normalizedIcon);
  expect(ownList.find((item) => item.key === 'taobao')).toMatchObject({
    current: own,
    latest_version: 1,
    revision: 2,
  });
  expect(ownList.find((item) => item.key === 'wechat_pay')).toEqual(builtin('wechat_pay'));
  expect(await history(f, 'taobao')).toMatchObject({ total: 1 });
  expect((await history(f, 'taobao')).items.map(normalizedVersion)).toEqual([own]);
  expect(await history(f, 'wechat_pay')).toMatchObject({ total: 0, items: [] });
  const otherSession = await signedIn(f, other);
  const reverse = { ...f, token: otherSession.admin_token };
  expect(
    (await list(reverse)).map(normalizedIcon).find((item) => item.key === 'taobao'),
  ).toMatchObject({
    current: foreign,
    latest_version: 99,
    revision: 7,
  });
  expect((await history(reverse, 'taobao')).items.map((item) => item.version)).toEqual([99, 1]);
  expect(await history(reverse, 'taobao')).toMatchObject({ total: 2 });
  expect(await history(reverse, 'jd')).toMatchObject({ total: 0, items: [] });
});

it('[AC-F1-06w#7] 两个读接口不改三张平台标识表，也不写审计', async () => {
  const f = await setup(h);
  await version(h, f.actor, 'wechat', 1, { ever_published: true });
  await icon(h, f.actor, 'wechat', 1, 5);
  const snapshot = async () => ({
    icons: await h.db
      .selectFrom('platform_icons')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('key')
      .execute(),
    versions: await h.db
      .selectFrom('platform_icon_versions')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('version')
      .execute(),
    uploads: await h.db
      .selectFrom('platform_icon_uploads')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    audit: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  });
  const before = await snapshot();
  expect(await list(f)).toHaveLength(8);
  expect(await history(f, 'wechat')).toMatchObject({ total: 1 });
  expect(await snapshot()).toEqual(before);
});
