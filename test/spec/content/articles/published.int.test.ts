// F1-02f rulings 2, 3, 5: what counts as published, which revision is current, app isolation.
// Every test seeds under its own app_id (couli_app has no DELETE on articles).
import { expect, it } from 'vitest';
import {
  at,
  detail,
  detailRaw,
  list,
  newAppId,
  newId,
  notFound,
  sameInstant,
  seedArticle,
  useHarness,
} from './kit.ts';

const h = useHarness('published', () => import('@couli/db/testing'));

it('[AC-F1-02f#1] only status exactly "published" with published_at set and not in the future counts as published', async () => {
  const appId = newAppId();
  const good = await seedArticle(h.db, { id: newId(), appId, category: 'help', title: '已发布' });
  // Exactly at now is published (published_at <= now).
  const atNow = await seedArticle(h.db, {
    id: newId(),
    appId,
    category: 'help',
    publishedAt: at(0),
  });
  const unpublished = [
    await seedArticle(h.db, { id: newId(), appId, category: 'help', status: 'draft' }),
    await seedArticle(h.db, { id: newId(), appId, category: 'help', status: 'offline' }),
    await seedArticle(h.db, { id: newId(), appId, category: 'help', status: 'Published' }),
    await seedArticle(h.db, { id: newId(), appId, category: 'help', status: 'published ' }),
    await seedArticle(h.db, { id: newId(), appId, category: 'help', publishedAt: null }),
    // Scheduled: one millisecond in the future is not yet published.
    await seedArticle(h.db, { id: newId(), appId, category: 'help', publishedAt: at(1) }),
  ];

  const page = await list(h, appId, 'help');
  expect(page.items.map((item) => item.article_id).sort()).toEqual([good.id, atNow.id].sort());
  expect(page.next_cursor).toBeNull();

  expect((await detail(h, appId, good.id)).title).toBe('已发布');
  for (const row of unpublished) {
    await notFound(await detailRaw(h, appId, row.id));
    await notFound(await detailRaw(h, appId, row.id, 1));
  }
});

it('[AC-F1-02f#1] a scheduled article becomes visible once the injected clock reaches published_at', async () => {
  const appId = newAppId();
  const row = await seedArticle(h.db, {
    id: newId(),
    appId,
    category: 'rule',
    publishedAt: at(60_000),
  });

  expect((await list(h, appId, 'rule')).items).toEqual([]);
  await notFound(await detailRaw(h, appId, row.id));

  h.clock.advanceMs(60_000);
  expect((await list(h, appId, 'rule')).items.map((item) => item.article_id)).toEqual([row.id]);
  expect((await detail(h, appId, row.id)).version).toBe(1);
});

it('[AC-F1-02f#2] the current version is the highest published revision; drafts, scheduled and unknown versions are 30701', async () => {
  const appId = newAppId();
  const id = newId();
  const v1 = await seedArticle(h.db, {
    id,
    appId,
    category: 'help',
    version: 1,
    title: '第一版',
    body: '第一版正文',
    publishedAt: at(-7_200_000),
  });
  const v2 = await seedArticle(h.db, {
    id,
    appId,
    category: 'help',
    version: 2,
    title: '第二版',
    body: '  第二版正文\n<b>原样</b>  ',
    publishedAt: at(-3_600_000),
  });
  await seedArticle(h.db, {
    id,
    appId,
    category: 'help',
    version: 3,
    title: '草稿',
    status: 'draft',
  });
  await seedArticle(h.db, {
    id,
    appId,
    category: 'help',
    version: 4,
    title: '定时',
    publishedAt: at(3_600_000),
  });

  const page = await list(h, appId, 'help');
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    article_id: id,
    category: 'help',
    title: '第二版',
    version: 2,
  });
  expect(page.items[0]!).not.toHaveProperty('notice');
  sameInstant(page.items[0]!.published_at, v2.publishedAt);

  const current = await detail(h, appId, id);
  expect(current).toEqual({
    article_id: id,
    category: 'help',
    title: '第二版',
    version: 2,
    published_at: current.published_at,
    body: '  第二版正文\n<b>原样</b>  ',
  });
  sameInstant(current.published_at, v2.publishedAt);

  const old = await detail(h, appId, id, 1);
  expect(old).toMatchObject({ article_id: id, title: '第一版', version: 1, body: '第一版正文' });
  sameInstant(old.published_at, v1.publishedAt);
  expect(await detail(h, appId, id, 2)).toMatchObject({ title: '第二版', version: 2 });

  await notFound(await detailRaw(h, appId, id, 3));
  await notFound(await detailRaw(h, appId, id, 4));
  await notFound(await detailRaw(h, appId, id, 9));
});

it('[AC-F1-02f#2] when only the first revision is a draft, a later published revision is current and the draft stays unreadable', async () => {
  const appId = newAppId();
  const id = newId();
  await seedArticle(h.db, {
    id,
    appId,
    category: 'agreement',
    version: 1,
    title: '旧草稿',
    status: 'draft',
  });
  await seedArticle(h.db, { id, appId, category: 'agreement', version: 2, title: '发布版' });

  const page = await list(h, appId, 'agreement');
  expect(page.items.map((item) => [item.article_id, item.version, item.title])).toEqual([
    [id, 2, '发布版'],
  ]);
  expect(await detail(h, appId, id)).toMatchObject({ version: 2, title: '发布版' });
  await notFound(await detailRaw(h, appId, id, 1));
});

it('[AC-F1-02f#3] the category comes from the current version: help v1 then rule v2 lists only under rule', async () => {
  const appId = newAppId();
  const moved = newId();
  await seedArticle(h.db, { id: moved, appId, category: 'help', version: 1, title: '帮助旧版' });
  await seedArticle(h.db, { id: moved, appId, category: 'rule', version: 2, title: '规则新版' });
  // A newer draft in another category does not move the article.
  const stays = newId();
  await seedArticle(h.db, { id: stays, appId, category: 'help', version: 1, title: '仍是帮助' });
  await seedArticle(h.db, {
    id: stays,
    appId,
    category: 'agreement',
    version: 2,
    status: 'draft',
  });

  const rule = await list(h, appId, 'rule');
  expect(rule.items.map((item) => [item.article_id, item.version, item.title])).toEqual([
    [moved, 2, '规则新版'],
  ]);
  const help = await list(h, appId, 'help');
  expect(help.items.map((item) => [item.article_id, item.version, item.title])).toEqual([
    [stays, 1, '仍是帮助'],
  ]);
  expect((await list(h, appId, 'agreement')).items).toEqual([]);

  expect(await detail(h, appId, moved)).toMatchObject({ category: 'rule', version: 2 });
  expect(await detail(h, appId, moved, 1)).toMatchObject({ category: 'help', version: 1 });
});

it('[AC-F1-02f#8] another app’s published articles never enter this app’s list or detail', async () => {
  const mine = newAppId();
  const other = newAppId();
  const own = await seedArticle(h.db, {
    id: newId(),
    appId: mine,
    category: 'help',
    title: '本应用',
  });
  const foreign = await seedArticle(h.db, {
    id: newId(),
    appId: other,
    category: 'help',
    title: '别的应用',
  });
  // Same article id with a higher version under another app must not become this app's current.
  await seedArticle(h.db, {
    id: own.id,
    appId: other,
    category: 'help',
    version: 2,
    title: '串号',
  });

  const page = await list(h, mine, 'help');
  expect(page.items.map((item) => [item.article_id, item.version, item.title])).toEqual([
    [own.id, 1, '本应用'],
  ]);
  expect(await detail(h, mine, own.id)).toMatchObject({ version: 1, title: '本应用' });
  await notFound(await detailRaw(h, mine, own.id, 2));
  await notFound(await detailRaw(h, mine, foreign.id));

  const theirs = await list(h, other, 'help');
  expect(theirs.items.map((item) => item.article_id).sort()).toEqual([own.id, foreign.id].sort());
});
