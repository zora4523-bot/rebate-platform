// B3-08i content 只读入口 published-articles.ts (ledger notes: only app.articles, category ∈
// help / rule, status = published; returns id, app_id, version, title, body, published_at; exported
// through content's index.ts). D10-386: createPublishedArticlesReader({ db, clock }).list(appId),
// the reader app.module builds for agent (the kit builds it the same way). One item per article: its current revision, the largest version
// whose status is exactly published and whose published_at is not later than the Clock (04 §6.2,
// the same current version the help center serves), so a newer draft or a scheduled revision never
// shows early (BR-AI-04: rule answers only from CMS published versions).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { LATER, NOW, TOMORROW, bodyOf, databaseKit, newAppId, type StoredArticle } from './kit.ts';

const h = databaseKit(createTestDatabase);
const REPUBLISHED_AT = new FixedClock('2026-10-25T00:00:00.000Z').now();

function byId<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function listed(row: StoredArticle) {
  return {
    id: row.id,
    app_id: row.app_id,
    version: row.version,
    title: row.title,
    body: row.body,
    published_at: row.published_at,
  };
}

it('[AC-B3-08i#7][BR-AI-04] 每篇 help / rule 只列当前版本（status=published 且 published_at ≤ 时钟的最大版本），字段恰为 id、app_id、version、title、body、published_at；notice / agreement、草稿、已下线、未到发布时间与他 app 的文章不列', async () => {
  const appId = newAppId();
  const help = await h.article({
    appId,
    category: 'help',
    title: '新手指南',
    body: bodyOf('第一步'),
  });
  const rule = await h.article({ appId, category: 'rule', body: bodyOf('旧规则') });
  const ruleNow = await h.article({
    appId,
    id: rule.id,
    category: 'rule',
    version: 2,
    body: bodyOf('新规则'),
    publishedAt: REPUBLISHED_AT,
  });
  const withDraft = await h.article({ appId, body: bodyOf('现行说明') });
  await h.article({ appId, id: withDraft.id, version: 2, status: 'draft', body: bodyOf('草稿') });
  const withScheduled = await h.article({ appId, category: 'rule', body: bodyOf('现行规则') });
  await h.article({
    appId,
    id: withScheduled.id,
    category: 'rule',
    version: 2,
    body: bodyOf('预告规则'),
    publishedAt: TOMORROW,
  });
  // published_at equal to the Clock is already due.
  const dueNow = await h.article({
    appId,
    category: 'rule',
    body: bodyOf('刚发布'),
    publishedAt: NOW,
  });
  await h.article({ appId, publishedAt: TOMORROW, body: bodyOf('定时发布') });
  await h.article({ appId, category: 'notice', body: bodyOf('公告') });
  await h.article({ appId, category: 'agreement', body: bodyOf('协议') });
  await h.article({ appId, status: 'draft', body: bodyOf('只有草稿') });
  await h.article({ appId, status: 'offline', body: bodyOf('已下线') });
  const withdrawn = await h.article({ appId, body: bodyOf('下线前一版') });
  await h.article({ appId, id: withdrawn.id, version: 2, body: bodyOf('下线前二版') });
  await h.setStatus(withdrawn.id, 'offline');
  await h.article({ appId: newAppId(), category: 'help', body: bodyOf('他 app') });

  const got = await h.published(appId);
  expect(byId(got)).toEqual(byId([help, ruleNow, withDraft, withScheduled, dueNow].map(listed)));
  for (const item of got) {
    expect(Object.keys(item).sort()).toEqual(
      ['app_id', 'body', 'id', 'published_at', 'title', 'version'].sort(),
    );
    expect(item.published_at).toBeInstanceOf(Date);
  }
});

it('[AC-B3-08i#8][BR-AI-04] 只读、每次现读不缓存：同一个读取器实例（app.module 只组装一次）每次 list 都按当时的时钟现读，调用不改 app.articles；新版本发布、文章下线与定时版本到点，下一次调用即反映', async () => {
  const appId = newAppId();
  const help = await h.article({ appId, body: bodyOf('第一版') });
  const scheduled = await h.article({
    appId,
    category: 'rule',
    body: bodyOf('定时规则'),
    publishedAt: TOMORROW,
  });
  // One Clock and one reader for every call below.
  const w = h.wiring(NOW);
  const before = await h.articles(appId);
  expect(await w.list(appId)).toEqual([listed(help)]);
  expect(await h.articles(appId)).toEqual(before);

  const next = await h.article({
    appId,
    id: help.id,
    version: 2,
    body: bodyOf('第二版'),
    publishedAt: LATER,
  });
  // Same Clock: v2 is not due yet.
  expect(await w.list(appId)).toEqual([listed(help)]);
  w.clock.set(LATER);
  expect(await w.list(appId)).toEqual([listed(next)]);
  w.clock.set(TOMORROW);
  const both = byId([listed(next), listed(scheduled)]);
  expect(byId(await w.list(appId))).toEqual(both);

  // Same Clock, the article goes offline between calls.
  await h.setStatus(help.id, 'offline');
  expect(await w.list(appId)).toEqual([listed(scheduled)]);
  const added = await h.article({ appId, category: 'rule', body: bodyOf('新上线') });
  expect(byId(await w.list(appId))).toEqual(byId([listed(scheduled), listed(added)]));
  expect(byId(await h.published(appId, TOMORROW))).toEqual(byId(await w.list(appId)));
});
