import { expect, it } from 'vitest';
import { fixture, useHarness } from './harness.ts';
import { get, invalid, list, newAppId, publicDetail, seedArticle, validate } from './kit.ts';

const h = useHarness(() => import('@couli/db/testing'));

it('[AC-F1-02zs#1] 按子分类只取匹配帮助文章；不筛选仍返回全部，空值省略字段', async () => {
  const { app } = await fixture(h, 'api');
  const appId = newAppId();
  const a = await seedArticle(h, appId, { help_section: 'invite' });
  const b = await seedArticle(h, appId, { help_section: 'withdraw' });
  const c = await seedArticle(h, appId);
  const filtered = await list(app, appId, { help_section: 'invite' });
  expect(filtered.items).toEqual([
    expect.objectContaining({ article_id: a, help_section: 'invite' }),
  ]);
  expect(filtered.next_cursor).toBeNull();
  const all = await list(app, appId);
  expect(all.items.map((row) => row.article_id)).toEqual([c, b, a]);
  expect(all.items.find((row) => row.article_id === a)).toHaveProperty('help_section', 'invite');
  expect(all.items.find((row) => row.article_id === b)).toHaveProperty('help_section', 'withdraw');
  expect(all.items.find((row) => row.article_id === c)).not.toHaveProperty('help_section');
  expect(await publicDetail(app, appId, c)).not.toHaveProperty('help_section');
});

it('[AC-F1-02zs#2] 先选最大已生效版本再筛；草稿、未来发布、下线不能覆盖当前版本，旧详情取旧值', async () => {
  const { app, clock } = await fixture(h, 'api');
  const appId = newAppId();
  const id = await seedArticle(h, appId, { help_section: 'invite' });
  // v2 发布时间比 v1 早，仍应以版本号判定当前版本。
  await seedArticle(h, appId, {
    id,
    version: 2,
    help_section: 'withdraw',
    published_at: '2026-10-19T00:00:00Z',
  });
  await seedArticle(h, appId, {
    id,
    version: 3,
    help_section: 'invite',
    status: 'draft',
    published_at: null,
  });
  const due = new Date(clock.now().getTime() + 60_000);
  await seedArticle(h, appId, { id, version: 4, help_section: 'invite', published_at: due });
  await seedArticle(h, appId, {
    id,
    version: 5,
    help_section: 'account_privacy',
    status: 'offline',
  });
  expect((await list(app, appId, { help_section: 'invite' })).items).toEqual([]);
  expect((await list(app, appId, { help_section: 'withdraw' })).items).toEqual([
    expect.objectContaining({ article_id: id, version: 2, help_section: 'withdraw' }),
  ]);
  expect(await publicDetail(app, appId, id, 1)).toMatchObject({
    version: 1,
    help_section: 'invite',
  });
  expect(await publicDetail(app, appId, id)).toMatchObject({
    version: 2,
    help_section: 'withdraw',
  });
  clock.set(new Date(due.getTime() - 1));
  expect(
    (await list(app, appId, { help_section: 'withdraw' })).items.map((row) => row.version),
  ).toEqual([2]);
  clock.set(due);
  expect((await list(app, appId, { help_section: 'withdraw' })).items).toEqual([]);
  expect((await list(app, appId, { help_section: 'invite' })).items).toEqual([
    expect.objectContaining({ article_id: id, version: 4, help_section: 'invite' }),
  ]);
});

it('[AC-F1-02zs#3] 当前版本清空子分类或改成规则时，不复活旧的 invite 版本', async () => {
  const { app } = await fixture(h, 'api');
  const appId = newAppId();
  const cleared = await seedArticle(h, appId, { help_section: 'invite' });
  await seedArticle(h, appId, { id: cleared, version: 2, help_section: null });
  const moved = await seedArticle(h, appId, { help_section: 'invite' });
  await seedArticle(h, appId, { id: moved, version: 2, category: 'rule', help_section: null });
  expect((await list(app, appId, { help_section: 'invite' })).items).toEqual([]);
  const all = await list(app, appId);
  expect(all.items.map((row) => row.article_id)).toEqual([cleared]);
  expect(all.items[0]).not.toHaveProperty('help_section');
  expect(await publicDetail(app, appId, cleared)).not.toHaveProperty('help_section');
  expect(await publicDetail(app, appId, cleared, 1)).toHaveProperty('help_section', 'invite');
  expect(await publicDetail(app, appId, moved)).not.toHaveProperty('help_section');
});

it.each(['rule', 'notice', 'agreement'] as const)(
  '[AC-F1-02zs#4] %s 与 help_section 不兼容，先于游标校验；编码大小写及未知值拒绝',
  async (category) => {
    const { app } = await fixture(h, 'api');
    const appId = newAppId();
    for (const value of ['Invite', 'unknown_section']) {
      await invalid(
        await get(app, appId, `/v1/articles?category=help&help_section=${value}`, 'publicList'),
      );
    }
    for (const suffix of ['', '&cursor=broken']) {
      await invalid(
        await get(
          app,
          appId,
          `/v1/articles?category=${category}&help_section=invite${suffix}`,
          'publicList',
        ),
        ['help_section'],
      );
    }
  },
);

it('[AC-F1-02zs#5] 筛选在分页前完成，微秒与同刻 id 连续翻页，游标不绑定子分类', async () => {
  const { app } = await fixture(h, 'api');
  const appId = newAppId();
  const ids: string[] = [];
  const matching: string[] = [];
  // 后插入的两条是非匹配项：取一页再在 JS 过滤会得到短页或空页。
  for (let i = 0; i < 10; i += 1) {
    const section = [0, 2, 4, 5, 7].includes(i) ? 'invite' : 'withdraw';
    const id = await seedArticle(h, appId, {
      help_section: section,
      published_at: `2026-10-20T01:00:00.00000${Math.floor(i / 2) + 1}Z`,
    });
    ids.push(id);
    if (section === 'invite') matching.push(id);
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const page = await list(app, appId, {
      help_section: 'invite',
      limit: 2,
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(page.items).toHaveLength(pageIndex === 2 ? 1 : 2);
    for (const row of page.items) expect(row).toHaveProperty('help_section', 'invite');
    seen.push(...page.items.map((row) => row.article_id));
    if (pageIndex === 2) expect(page.next_cursor).toBeNull();
    else {
      expect(page.next_cursor).toEqual(expect.any(String));
      cursor = page.next_cursor!;
      const last = page.items.at(-1)!;
      expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual([
        'help',
        last.published_at,
        last.article_id,
      ]);
    }
  }
  expect(seen).toEqual([...matching].reverse());
  expect(new Set(seen).size).toBe(seen.length);
  const unfiltered = await list(app, appId, { limit: 4 });
  expect(unfiltered.items.map((row) => row.article_id)).toEqual(ids.slice(-4).reverse());
  expect(unfiltered.next_cursor).toEqual(expect.any(String));
  const continued = await list(app, appId, {
    help_section: 'invite',
    cursor: unfiltered.next_cursor!,
    limit: 10,
  });
  expect(continued.items.map((row) => row.article_id)).toEqual(matching.slice(0, 4).reverse());
  expect(continued.next_cursor).toBeNull();
});

it('[AC-F1-02zs#6] app_id 隔离；公告与协议无子分类，帮助详情保留值', async () => {
  const { app } = await fixture(h, 'api');
  const appId = newAppId();
  const otherApp = newAppId();
  const own = await seedArticle(h, appId, { help_section: 'invite' });
  const other = await seedArticle(h, otherApp, { help_section: 'invite' });
  // 当前版本子查询也必须隔离 app_id，另一 app 的同 id 高版本不能覆盖本 app。
  await seedArticle(h, otherApp, { id: own, version: 2, help_section: 'withdraw' });
  await seedArticle(h, appId, { help_section: 'withdraw' });
  for (const category of ['notice', 'agreement'] as const) {
    const id = await seedArticle(h, appId, { category });
    const page = await list(app, appId, { category });
    expect(page.items.map((row) => row.article_id)).toEqual([id]);
    expect(page.items[0]).not.toHaveProperty('help_section');
    expect(await publicDetail(app, appId, id)).not.toHaveProperty('help_section');
  }
  const absent = await get(app, appId, `/v1/articles/${other}`, 'publicDetail');
  expect(absent.response.statusCode).toBe(404);
  expect(absent.response.json()).toMatchObject({ code: 30701 });
  await validate(absent);
  expect((await list(app, appId, { help_section: 'invite' })).items).toEqual([
    expect.objectContaining({ article_id: own, help_section: 'invite' }),
  ]);
  expect((await list(app, otherApp, { help_section: 'invite' })).items).toEqual([
    expect.objectContaining({ article_id: other, help_section: 'invite' }),
  ]);
  expect(await publicDetail(app, appId, own)).toHaveProperty('help_section', 'invite');
});
