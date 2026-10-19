import { expect, it, vi } from 'vitest';
import { AdminOperationGuardImpl } from '../../../../apps/api/src/modules/admin/application/admin-operation-guard.ts';
import { useHarness } from './harness.ts';
import {
  audit,
  conflict,
  create,
  detail,
  draft,
  fields,
  instant,
  list,
  member,
  newId,
  publish,
  rejected,
  save,
  seedArticle,
  send,
  setup,
  snapshot,
  success,
} from './kit.ts';

vi.mock('../../../../packages/domain/src/state-machines/article-version.gen.ts', { spy: true });

const h = useHarness(() => import('@couli/db/testing'));

it('[AC-F1-02w#34] 两个 GET 用 content.article 和 readOnly 守卫', async () => {
  const f = await setup(h);
  const id = (await create(f)).article_id;
  const guard = vi.spyOn(AdminOperationGuardImpl.prototype, 'run');
  try {
    for (const op of ['list', 'detail'] as const) {
      guard.mockClear();
      await success(await send(f, op, id));
      expect(guard).toHaveBeenCalled();
      expect(guard.mock.lastCall![0]).toMatchObject({
        permission: 'content.article',
        readOnly: true,
      });
    }
  } finally {
    guard.mockRestore();
  }
});

it.each(['list', 'detail', 'create', 'save', 'publish', 'offline'] as const)(
  '[AC-F1-02w#23] %s 都要求 content.article，其他 content 权限不能替代',
  async (op) => {
    const f = await setup(h);
    const id = (await create(f)).article_id;
    if (op === 'offline') await publish(f, id, 0, 1);
    const denied = await member(h, f, ['content.page']);
    const before = await snapshot(h, f.appId);
    const payloads = {
      list: undefined,
      detail: undefined,
      create: { article_id: newId(), category: 'help', ...draft() },
      save: { ...draft(), expected_row_version: 0 },
      publish: { version: 1, expected_row_version: 0 },
      offline: { expected_row_version: 1 },
    };
    await rejected(await send(f, op, id, payloads[op], { token: denied.token }), 10403, {
      reason: 'admin_permission_denied',
    });
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-F1-02w#24] 普通授权管理员不带 step-up 完成六操作，读无审计，写恰一条', async () => {
  const f = await setup(h);
  const id = newId();
  let before = await snapshot(h, f.appId);
  expect(await create(f, id)).toMatchObject({ row_version: 0 });
  await audit(h, f, before, 'create', id);
  before = await snapshot(h, f.appId);
  expect(await save(f, id, 0)).toMatchObject({ row_version: 1 });
  await audit(h, f, before, 'save', id);
  before = await snapshot(h, f.appId);
  expect(await publish(f, id, 1, 2)).toMatchObject({ row_version: 2 });
  await audit(h, f, before, 'publish', id);
  before = await snapshot(h, f.appId);
  f.clock.advanceMs(1000);
  expect(await success(await send(f, 'offline', id, { expected_row_version: 2 }))).toMatchObject({
    row_version: 3,
  });
  await audit(h, f, before, 'offline', id);
  const final = await snapshot(h, f.appId);
  expect((await list(f)).items.map((a) => a.article_id)).toEqual([id]);
  expect((await detail(f, id)).versions.map((v) => v.status)).toEqual(['offline', 'draft']);
  expect(await snapshot(h, f.appId)).toEqual(final);
});

it('[AC-F1-02w#25] 列表按各 id 最新行筛选、排序与分页，详情包含全部版本新到旧', async () => {
  const f = await setup(h);
  const a = newId();
  const b = newId();
  const c = newId();
  const agreement = newId();
  const now = f.clock.now();
  const old = new Date(now.getTime() - 60_000);
  const newer = new Date(now.getTime() + 1000);
  // a 的旧行更新时间更晚，不能据旧行排序或把旧 published 当最新状态。
  await seedArticle(h, f, a, { status: 'published', published_at: old, updated_at: newer });
  await seedArticle(h, f, a, { version: 2, title: '新草稿标题', row_version: 6, updated_at: now });
  await seedArticle(h, f, b, { status: 'published', published_at: old, updated_at: now });
  await seedArticle(h, f, c, {
    category: 'notice',
    status: 'offline',
    published_at: old,
    updated_at: newer,
  });
  await seedArticle(h, f, agreement, { category: 'agreement', updated_at: old });
  const before = await snapshot(h, f.appId);
  const first = await list(f, '?page=1&page_size=2');
  expect(first).toMatchObject({ page: 1, page_size: 2, total: 4 });
  expect(first.items.map((r) => r.article_id)).toEqual([c, a]);
  expect(first.items[1]).toMatchObject({
    latest_version: 2,
    latest_status: 'draft',
    title: '新草稿标题',
    row_version: 6,
    current_version: 1,
  });
  expect(instant(first.items[1]!.published_at)).toBe(old.toISOString());
  expect(instant(first.items[1]!.updated_at)).toBe(now.toISOString());
  const second = await list(f, '?page=2&page_size=2');
  expect(second).toMatchObject({ page: 2, page_size: 2, total: 4 });
  expect(second.items.map((r) => r.article_id)).toEqual([b, agreement]);
  expect(await list(f, '?page=3&page_size=2')).toMatchObject({ items: [], total: 4 });
  expect((await list(f, '?status=draft')).items.map((r) => r.article_id)).toEqual([a, agreement]);
  expect((await list(f, '?status=published')).items.map((r) => r.article_id)).toEqual([b]);
  expect((await list(f, '?status=offline')).items.map((r) => r.article_id)).toEqual([c]);
  expect(await list(f, '?category=help&status=draft')).toMatchObject({
    total: 1,
    items: [{ article_id: a }],
  });
  expect((await detail(f, a)).versions.map((v) => [v.version, v.status])).toEqual([
    [2, 'draft'],
    [1, 'published'],
  ]);
  expect((await detail(f, c)).versions[0]!.status).toBe('offline');
  expect((await detail(f, agreement)).category).toBe('agreement');
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02w#26] app 只取登录身份：伪造头不越权，外 app 的 id 四个接口都是 30701', async () => {
  const f = await setup(h);
  const otherApp = `${f.appId}_b`;
  const id = newId();
  await seedArticle(h, f, id, {
    app_id: otherApp,
    status: 'published',
    published_at: f.clock.now(),
  });
  const before = await snapshot(h, f.appId);
  const foreign = await snapshot(h, otherApp);
  for (const [op, payload] of [
    ['detail', undefined],
    ['save', { ...draft(), expected_row_version: 0 }],
    ['publish', { version: 1, expected_row_version: 0 }],
    ['offline', { expected_row_version: 0 }],
  ] as const) {
    await rejected(await send(f, op, id, payload, { headers: { 'x-app-id': otherApp } }), 30701);
  }
  expect((await list(f)).items).toEqual([]);
  const ownId = newId();
  const own = await success(
    await send(
      f,
      'create',
      ownId,
      {
        article_id: ownId,
        category: 'help',
        ...draft(),
      },
      { headers: { 'x-app-id': otherApp } },
    ),
  );
  expect(own.article_id).toBe(ownId);
  expect((await snapshot(h, f.appId)).rows).toHaveLength(before.rows.length + 1);
  expect(await snapshot(h, otherApp)).toEqual(foreign);
});

it('[AC-F1-02w#27] 创建全局 id 碰撞（其他 app 或只有高版本行）均 20902，不插入 v1', async () => {
  const f = await setup(h);
  const id = newId();
  const otherApp = `${f.appId}_b`;
  await seedArticle(h, f, id, { app_id: otherApp, version: 7 });
  const before = await snapshot(h, f.appId);
  const foreign = await snapshot(h, otherApp);
  await conflict(await send(f, 'create', id, { article_id: id, category: 'help', ...draft() }));
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await snapshot(h, otherApp)).toEqual(foreign);
});

it('[AC-F1-02w#28] 并发新建相同 id 恰一成功一冲突，不把 PG 主键冲突暴露为 500', async () => {
  const f = await setup(h);
  const id = newId();
  const before = await snapshot(h, f.appId);
  const results = await Promise.all(
    [1, 2].map(() => send(f, 'create', id, { article_id: id, category: 'help', ...draft() })),
  );
  expect(results.map((r) => r.response.statusCode).sort()).toEqual([200, 409]);
  expect(await success(results.find((r) => r.response.statusCode === 200)!)).toMatchObject({
    row_version: 0,
  });
  await conflict(results.find((r) => r.response.statusCode === 409)!);
  expect((await snapshot(h, f.appId)).rows).toHaveLength(1);
  await audit(h, f, before, 'create', id);
});

it.each([
  'NOT-A-UUID',
  '0199F102-AAAA-7000-8000-000000000001',
  '0199f102-aaaa-7000-8000-ffffffffffff',
])('[AC-F1-02w#29] 非规范或不存在 id 在详情和三个写优先返回 30701：%s', async (id) => {
  const f = await setup(h);
  // 大写用例先种入对应的小写 id，不能仅因查不到行而误通过。
  if (id.includes('AAAA')) {
    await seedArticle(h, f, id.toLowerCase());
    expect((await detail(f, id.toLowerCase())).article_id).toBe(id.toLowerCase());
  }
  const before = await snapshot(h, f.appId);
  for (const [op, payload] of [
    ['detail', undefined],
    ['save', { ...draft({ title: '全网最低' }), expected_row_version: 99 }],
    ['publish', { version: 99, expected_row_version: 99 }],
    ['offline', { expected_row_version: 99 }],
  ] as const) {
    await rejected(await send(f, op, id, payload), 30701);
    expect(await snapshot(h, f.appId)).toEqual(before);
  }
});

it('[AC-F1-02w#30] 已有小写规范 UUIDv4 可读取与存稿，不把新建 v7 限制套到已有文章', async () => {
  const f = await setup(h);
  const id = '0199f102-aaaa-4000-8000-000000000001';
  await seedArticle(h, f, id);
  expect((await detail(f, id)).article_id).toBe(id);
  expect(await save(f, id, 0)).toMatchObject({ row_version: 1 });
});

it.each([
  ['?page=0', 'page'],
  ['?page_size=201', 'page_size'],
  ['?category=unknown', 'category'],
  ['?status=unknown', 'status'],
])('[AC-F1-02w#31] 列表分页及筛选遵守契约：%s', async (query, field) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  await fields(await send(f, 'list', '', undefined, { query }), [field]);
  expect(await snapshot(h, f.appId)).toEqual(before);
});
