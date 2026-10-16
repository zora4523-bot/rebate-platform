// F1-02f rulings 7–10, 12: NoticeItem built from the current revision, the notice effective window
// [published_at, notice_end_at), dirty notice rows dropped in SQL, no caching between requests.
import { expect, it } from 'vitest';
import {
  at,
  detail,
  detailRaw,
  list,
  listAll,
  newAppId,
  newId,
  notFound,
  sameInstant,
  seedArticle,
  useHarness,
  type Summary,
} from './kit.ts';

const h = useHarness('notice');

it('[AC-F1-02f#5] a notice item carries NoticeItem from the current revision; content_version is notice_content_version, not version', async () => {
  const appId = newAppId();
  const id = newId();
  for (const version of [1, 2]) {
    await seedArticle(h.db, {
      id,
      appId,
      category: 'notice',
      version,
      title: `旧标题 ${version}`,
      publishedAt: at(-7_200_000 + version),
      noticeClosable: false,
      noticeContentVersion: 1,
      noticeEndAt: at(60_000),
    });
  }
  const v3 = await seedArticle(h.db, {
    id,
    appId,
    category: 'notice',
    version: 3,
    title: '国庆期间到账说明',
    body: '公告正文',
    publishedAt: at(-3_600_000),
    noticeClosable: true,
    noticeContentVersion: 1,
    noticeEndAt: at(86_400_000),
  });

  const page = await list(h, appId, 'notice');
  expect(page.items).toHaveLength(1);
  const item = page.items[0]!;
  expect(item).toMatchObject({
    article_id: id,
    category: 'notice',
    title: '国庆期间到账说明',
    version: 3,
  });
  sameInstant(item.published_at, v3.publishedAt);
  expect(Object.keys(item.notice!).sort()).toEqual([
    'closable',
    'content_version',
    'end_at',
    'item_id',
    'start_at',
    'target',
    'text',
  ]);
  expect(item.notice).toMatchObject({
    item_id: id,
    content_version: 1,
    text: '国庆期间到账说明',
    target: { route: 'Help', params: { article_id: id } },
    closable: true,
  });
  expect(item.notice!.target).toEqual({ route: 'Help', params: { article_id: id } });
  sameInstant(item.notice!.start_at, v3.publishedAt);
  sameInstant(item.notice!.end_at, v3.noticeEndAt);
});

it('[AC-F1-02f#5] notice_content_version is reported as stored even when it differs from both 1 and version', async () => {
  const appId = newAppId();
  const id = newId();
  const row = await seedArticle(h.db, {
    id,
    appId,
    category: 'notice',
    version: 2,
    title: '内容版本单独维护',
    noticeClosable: false,
    noticeContentVersion: 7,
    noticeEndAt: at(1_000),
  });
  const [item] = (await list(h, appId, 'notice')).items;
  expect(item!.version).toBe(2);
  expect(item!.notice).toMatchObject({ item_id: id, content_version: 7, closable: false });
  sameInstant(item!.notice!.end_at, row.noticeEndAt);
});

it('[AC-F1-02f#5] help, rule and agreement items have no notice key and ignore the notice columns', async () => {
  const appId = newAppId();
  const ids: Record<string, string> = {};
  for (const category of ['help', 'rule', 'agreement'] as const) {
    ids[category] = newId();
    // Notice columns that would be filtered out on a notice row must not affect other categories.
    await seedArticle(h.db, {
      id: ids[category],
      appId,
      category,
      noticeClosable: false,
      noticeEndAt: null,
    });
    await seedArticle(h.db, {
      id: newId(),
      appId,
      category,
      noticeClosable: true,
      noticeEndAt: at(-60_000),
    });
  }
  for (const category of ['help', 'rule', 'agreement'] as const) {
    const page = await list(h, appId, category);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.article_id)).toContain(ids[category]);
    for (const item of page.items) {
      expect(item.category).toBe(category);
      expect(item).not.toHaveProperty('notice');
    }
  }
});

it('[AC-F1-02f#6] the notice list holds only items inside [published_at, notice_end_at); detail ignores the window', async () => {
  const appId = newAppId();
  const seed = (
    title: string,
    closable: boolean,
    endAt: string | null,
    publishedAt = at(-3_600_000),
  ) =>
    seedArticle(h.db, {
      id: newId(),
      appId,
      category: 'notice',
      title,
      publishedAt,
      noticeClosable: closable,
      noticeEndAt: endAt,
    });
  const live = await seed('生效中', false, at(1));
  const open = await seed('可关闭不过期', true, null);
  const expired = await seed('已过期', true, at(-1));
  const boundary = await seed('恰好到期', false, at(0));
  const stuck = await seed('不可关闭无期限', false, null);
  const empty = await seed('', true, null);
  const future = await seed('未开始', true, at(3_600_000), at(1));

  const page = await list(h, appId, 'notice');
  expect(page.items.map((item) => item.article_id).sort()).toEqual([live.id, open.id].sort());
  const byId = new Map(page.items.map((item): [string, Summary] => [item.article_id, item]));
  expect(byId.get(open.id)!.notice).toMatchObject({ closable: true, end_at: null });
  expect(byId.get(live.id)!.notice).toMatchObject({ closable: false });

  // Detail is not bound to the notice window (ruling 10), only to publication.
  expect(await detail(h, appId, expired.id)).toMatchObject({ category: 'notice', title: '已过期' });
  expect(await detail(h, appId, boundary.id)).toMatchObject({ title: '恰好到期' });
  expect(await detail(h, appId, stuck.id)).toMatchObject({ title: '不可关闭无期限' });
  expect(await detail(h, appId, empty.id)).toMatchObject({ title: '' });
  await notFound(await detailRaw(h, appId, future.id));
});

it('[AC-F1-02f#6] excluded notices are filtered before paging, so every non-final page is full', async () => {
  const appId = newAppId();
  const kept: string[] = [];
  // Newest first; excluded rows sit between the kept ones in the sort order.
  for (let n = 0; n < 4; n += 1) {
    const keep = newId();
    await seedArticle(h.db, {
      id: keep,
      appId,
      category: 'notice',
      publishedAt: at(-1_000 * (2 * n + 1)),
      noticeEndAt: at(60_000),
    });
    kept.push(keep);
    await seedArticle(h.db, {
      id: newId(),
      appId,
      category: 'notice',
      publishedAt: at(-1_000 * (2 * n + 2)),
      noticeClosable: n % 2 === 0,
      noticeEndAt: n % 2 === 0 ? at(-1) : null,
    });
  }
  const { ids, pages } = await listAll(h, appId, 'notice', 2);
  expect(ids).toEqual(kept);
  expect(pages.map((page) => page.items.length)).toEqual([2, 2]);
});

it('[AC-F1-02f#9] results are read fresh per request: a new article shows up without moving the clock', async () => {
  const appId = newAppId();
  const first = await seedArticle(h.db, {
    id: newId(),
    appId,
    category: 'help',
    publishedAt: at(-2_000),
  });
  const notice = await seedArticle(h.db, {
    id: newId(),
    appId,
    category: 'notice',
    noticeClosable: true,
    noticeEndAt: at(30_000),
  });
  expect((await list(h, appId, 'help')).items.map((item) => item.article_id)).toEqual([first.id]);
  expect((await list(h, appId, 'notice')).items.map((item) => item.article_id)).toEqual([
    notice.id,
  ]);

  const second = await seedArticle(h.db, {
    id: newId(),
    appId,
    category: 'help',
    publishedAt: at(-1_000),
  });
  expect((await list(h, appId, 'help')).items.map((item) => item.article_id)).toEqual([
    second.id,
    first.id,
  ]);
  // A new revision is visible at once too.
  await seedArticle(h.db, {
    id: first.id,
    appId,
    category: 'help',
    version: 2,
    title: '立即可见的新版',
    publishedAt: at(-500),
  });
  expect(await detail(h, appId, first.id)).toMatchObject({ version: 2, title: '立即可见的新版' });

  // Moving the clock past end_at (well inside any 60 s cache) removes the notice at once.
  h.clock.advanceMs(30_000);
  expect((await list(h, appId, 'notice')).items).toEqual([]);
});
