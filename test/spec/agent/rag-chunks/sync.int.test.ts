// B3-08i 触发 (ledger notes): syncRuleChunks(appId) compares the (article_id, version) of the
// current published help / rule revisions with the app's active chunks; missing chunks are
// inserted, every other active chunk is retired; repeating changes nothing; a unique-key conflict
// counts as already written (at-least-once). BR-AI-04: agent_rule_chunks only from CMS published
// versions. Real PG as couli_app, the agent's writer role for app.agent_rule_chunks. D10-386: the
// articles come only from the content reader passed in (the kit builds it as app.module does).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type {
  PublishedArticle,
  PublishedArticlesReader,
} from '../../../../apps/api/src/modules/content/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  IMAGE,
  LATER,
  NOW,
  PUBLISHED_AT,
  TITLE,
  TOMORROW,
  activeOf,
  bodyOf,
  databaseKit,
  doc,
  heading,
  newAppId,
  paragraph,
  retiredOf,
  shapeOf,
  sortedShape,
  type Row,
} from './kit.ts';

const h = databaseKit(createTestDatabase);
const REPUBLISHED_AT = new FixedClock('2026-10-25T00:00:00.000Z').now();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WIDE = '\u{20000}';

function byChunkId(rows: readonly Row[]): Map<unknown, Row> {
  return new Map(rows.map((row) => [row['chunk_id'], row]));
}

/** content's reader stand-in (no database), recording the app of each call. */
function stubReader(items: readonly PublishedArticle[]) {
  const calls: string[] = [];
  const reader: PublishedArticlesReader = {
    list(appId) {
      calls.push(appId);
      return Promise.resolve(items);
    },
  };
  return { reader, calls };
}

it('[AC-B3-08i#9][BR-AI-04][BR-AI-07] 首次同步：各篇已发布 help / rule 按切块规则写入 active 块（app_id、article_id、published_version、seq 从 0、标题取文章标题、正文 ≤200 码点），chunk_id 各不相同、retired_at 为空；没有文字的文章不写块', async () => {
  const appId = newAppId();
  const help = await h.article({
    appId,
    category: 'help',
    body: doc(
      heading(2, '结算时间'),
      paragraph('确认收货后返利进入待结算。'),
      paragraph('结算后可提现。'),
    ),
  });
  const rule = await h.article({
    appId,
    category: 'rule',
    title: '提现规则',
    body: bodyOf('规'.repeat(450)),
  });
  const wide = await h.article({
    appId,
    category: 'rule',
    title: '生僻字',
    body: bodyOf(WIDE.repeat(300)),
  });
  await h.article({ appId, body: doc(paragraph(IMAGE)) });

  expect(await h.sync(appId)).toEqual({ inserted: 8, retired: 0 });
  const rows = await h.chunks(appId);
  expect(shapeOf(rows)).toEqual(
    sortedShape([
      ...activeOf(help, ['结算时间', '确认收货后返利进入待结算。', '结算后可提现。']),
      ...activeOf(rule, ['规'.repeat(200), '规'.repeat(200), '规'.repeat(50)], '提现规则'),
      ...activeOf(wide, [WIDE.repeat(200), WIDE.repeat(100)], '生僻字'),
    ]),
  );
  expect(new Set(rows.map((row) => row['chunk_id'])).size).toBe(rows.length);
  for (const row of rows) {
    expect(row['chunk_id']).toMatch(UUID);
    expect(row['app_id']).toBe(appId);
    expect(row['retired_at']).toBeNull();
    expect(row['created_at']).toBeInstanceOf(Date);
  }
});

it('[AC-B3-08i#10][BR-AI-04] 每篇只取最高已发布版本：更早的已发布版本、更新的草稿与未到发布时间的版本都不写块；同一读取器与时钟反复同步（app.module 只组装一次），定时版本到点后的同步写入新版本并把上一版的块置 retired，文章下线后的同步把它的块置 retired', async () => {
  const appId = newAppId();
  const a1 = await h.article({ appId, body: bodyOf('旧版') });
  const a2 = await h.article({
    appId,
    id: a1.id,
    version: 2,
    body: bodyOf('新版'),
    publishedAt: REPUBLISHED_AT,
  });
  await h.article({ appId, id: a1.id, version: 3, status: 'draft', body: bodyOf('草稿') });
  const b1 = await h.article({ appId, category: 'rule', body: bodyOf('现行') });
  const b2 = await h.article({
    appId,
    id: b1.id,
    category: 'rule',
    version: 2,
    body: bodyOf('预告'),
    publishedAt: TOMORROW,
  });

  // One Clock and one reader for every sync below (the agent worker's periodic sync).
  const w = h.wiring(NOW);
  expect(await w.sync(appId)).toEqual({ inserted: 2, retired: 0 });
  const current = sortedShape([...activeOf(a2, ['新版']), ...activeOf(b1, ['现行'])]);
  expect(shapeOf(await h.chunks(appId))).toEqual(current);

  w.clock.set(TOMORROW);
  expect(await w.sync(appId)).toEqual({ inserted: 1, retired: 1 });
  const rows = await h.chunks(appId);
  expect(shapeOf(rows)).toEqual(
    sortedShape([
      ...activeOf(a2, ['新版']),
      ...retiredOf(activeOf(b1, ['现行'])),
      ...activeOf(b2, ['预告']),
    ]),
  );
  const old = rows.find((row) => row['article_id'] === b1.id && row['published_version'] === 1);
  expect(old?.['retired_at']).toEqual(TOMORROW);

  // Same reader and Clock; article a goes offline between syncs (Clock moved to tell retired_at).
  await h.setStatus(a1.id, 'offline');
  w.clock.set(new FixedClock('2026-10-28T09:00:00.000Z').now());
  expect(await w.sync(appId)).toEqual({ inserted: 0, retired: 1 });
  const offline = (await h.chunks(appId)).find((row) => row['article_id'] === a1.id);
  expect(offline?.['status']).toBe('retired');
  expect(offline?.['retired_at']).toEqual(w.clock.now());
});

it('[AC-B3-08i#11][BR-AI-04] 置 retired：旧版本、整篇下线、notice / agreement、草稿版本上的 active 块都在本次同步置 retired，retired_at 取时钟当前时刻，其余列不变；新版本的块同时写入', async () => {
  const appId = newAppId();
  const help = await h.article({ appId, body: bodyOf('第一版说明。') });
  const off = await h.article({ appId, category: 'rule', body: bodyOf('将下线的规则。') });
  expect(await h.sync(appId, NOW)).toEqual({ inserted: 2, retired: 0 });

  const help2 = await h.article({ appId, id: help.id, version: 2, body: bodyOf('第二版说明。') });
  await h.setStatus(off.id, 'offline');
  // Active rows the sync never wrote for these (an earlier writer, or category / status changes).
  const notice = await h.article({ appId, category: 'notice', body: bodyOf('公告') });
  const agreement = await h.article({ appId, category: 'agreement', body: bodyOf('协议') });
  const draft = await h.article({ appId, status: 'draft', body: bodyOf('草稿') });
  for (const source of [notice, agreement, draft]) {
    await h.chunk({ appId, articleId: source.id, version: 1, seq: 0, text: '过期块' });
  }
  const before = await h.chunks(appId);
  expect(before).toHaveLength(5);

  expect(await h.sync(appId, LATER)).toEqual({ inserted: 1, retired: 5 });
  const after = await h.chunks(appId);
  const stored = byChunkId(after);
  for (const row of before) {
    expect(stored.get(row['chunk_id'])).toEqual({ ...row, status: 'retired', retired_at: LATER });
  }
  const known = new Set(before.map((row) => row['chunk_id']));
  const added = after.filter((row) => !known.has(row['chunk_id']));
  expect(shapeOf(added)).toEqual(activeOf(help2, ['第二版说明。']));
  expect(added[0]?.['retired_at']).toBeNull();
});

it('[AC-B3-08i#12][BR-AI-04] 幂等：无变化时重复同步（含时钟前移）返回 inserted=0、retired=0，块表逐列不变（chunk_id、created_at 不变，已 retired 的块 retired_at 不被改写）', async () => {
  const appId = newAppId();
  const help = await h.article({ appId, body: bodyOf('第一段。', '第二段。') });
  await h.article({ appId, category: 'rule', body: bodyOf('规则一。') });
  expect(await h.sync(appId, NOW)).toEqual({ inserted: 3, retired: 0 });
  const first = await h.chunks(appId);
  for (const at of [NOW, LATER]) {
    expect(await h.sync(appId, at)).toEqual({ inserted: 0, retired: 0 });
    expect(await h.chunks(appId)).toEqual(first);
  }

  await h.article({ appId, id: help.id, version: 2, body: bodyOf('新一段。') });
  expect(await h.sync(appId, LATER)).toEqual({ inserted: 1, retired: 2 });
  const second = await h.chunks(appId);
  const retired = second.filter((row) => row['status'] === 'retired');
  expect(retired.map((row) => row['retired_at'])).toEqual([LATER, LATER]);
  expect(await h.sync(appId, TOMORROW)).toEqual({ inserted: 0, retired: 0 });
  expect(await h.chunks(appId)).toEqual(second);
});

it('[AC-B3-08i#13][BR-AI-04] 至少一次投递：上一次投递已写入的块（唯一键 article_id, published_version, seq 冲突）视为已写入，原行不变、同步不报错，只补缺的块', async () => {
  const appId = newAppId();
  const article = await h.article({ appId, body: bodyOf('第一段。', '第二段。', '第三段。') });
  const earlier = await h.chunk({
    appId,
    articleId: article.id,
    version: 1,
    seq: 0,
    title: TITLE,
    text: '第一段。',
  });
  const before = byChunkId(await h.chunks(appId)).get(earlier);

  expect(await h.sync(appId)).toEqual({ inserted: 2, retired: 0 });
  const rows = await h.chunks(appId);
  expect(shapeOf(rows)).toEqual(activeOf(article, ['第一段。', '第二段。', '第三段。']));
  expect(rows[0]).toEqual(before);
});

it('[AC-B3-08i#13][BR-AI-04] 至少一次投递：同一 app 的两次同步并发执行都成功返回，结果恰为一套 active 块（每个 article_id, published_version, seq 一行），之后再同步无变化', async () => {
  const appId = newAppId();
  const help = await h.article({ appId, body: bodyOf('第一段。', '第二段。') });
  const rule = await h.article({ appId, category: 'rule', body: bodyOf('规则一。', '规则二。') });

  const outcomes = await Promise.allSettled([h.sync(appId), h.sync(appId)]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
  const rows = await h.chunks(appId);
  expect(shapeOf(rows)).toEqual(
    sortedShape([
      ...activeOf(help, ['第一段。', '第二段。']),
      ...activeOf(rule, ['规则一。', '规则二。']),
    ]),
  );
  expect(await h.sync(appId)).toEqual({ inserted: 0, retired: 0 });
  expect(await h.chunks(appId)).toEqual(rows);
});

it('[AC-B3-08i#14][BR-AI-04] app 隔离：同步一个 app 只读它的文章、只写和置 retired 它的块，另一 app 的块逐列不变', async () => {
  const appA = newAppId();
  const appB = newAppId();
  const helpA = await h.article({ appId: appA, body: bodyOf('甲应用说明。') });
  const helpB = await h.article({ appId: appB, body: bodyOf('乙应用说明。') });
  const offB = await h.article({ appId: appB, status: 'offline', body: bodyOf('乙应用旧规则。') });
  await h.chunk({ appId: appB, articleId: offB.id, version: 1, seq: 0, text: '乙应用旧规则。' });
  const beforeB = await h.chunks(appB);

  expect(await h.sync(appA)).toEqual({ inserted: 1, retired: 0 });
  expect(shapeOf(await h.chunks(appA))).toEqual(activeOf(helpA, ['甲应用说明。']));
  expect(await h.chunks(appB)).toEqual(beforeB);

  const rowsA = await h.chunks(appA);
  expect(await h.sync(appB, LATER)).toEqual({ inserted: 1, retired: 1 });
  expect(shapeOf(await h.chunks(appB))).toEqual(
    sortedShape([
      ...activeOf(helpB, ['乙应用说明。']),
      ...retiredOf(activeOf(offB, ['乙应用旧规则。'])),
    ]),
  );
  expect(await h.chunks(appA)).toEqual(rowsA);
});

it('[AC-B3-08i#15][BR-AI-04] 文章只经注入的读取器取（D10-386）：给同步一个不经数据库的桩读取器，块按桩返回的文章（id、version、title、body）写入，桩没列出的文章的 active 块置 retired，与 app.articles 里的状态无关；读取器按本次 app_id 调用', async () => {
  const appId = newAppId();
  // In app.articles: x v1 published, x v2 a draft; y v1 published with an active chunk.
  const x = await h.article({ appId, body: bodyOf('库里正文。') });
  await h.article({ appId, id: x.id, version: 2, status: 'draft', body: bodyOf('库里草稿。') });
  const y = await h.article({ appId, category: 'rule', body: bodyOf('另一篇。') });
  await h.chunk({ appId, articleId: y.id, version: 1, seq: 0, text: '另一篇。' });
  const listedX = { id: x.id, version: 2 };
  const stub = stubReader([
    {
      ...listedX,
      app_id: appId,
      title: '桩标题',
      body: bodyOf('桩里第一段。', '桩里第二段。'),
      published_at: PUBLISHED_AT,
    },
  ]);

  expect(await h.syncWith(appId, stub.reader, LATER)).toEqual({ inserted: 2, retired: 1 });
  expect(stub.calls.length).toBeGreaterThan(0);
  expect(new Set(stub.calls)).toEqual(new Set([appId]));
  const rows = await h.chunks(appId);
  expect(shapeOf(rows)).toEqual(
    sortedShape([
      ...activeOf(listedX, ['桩里第一段。', '桩里第二段。'], '桩标题'),
      ...retiredOf(activeOf(y, ['另一篇。'])),
    ]),
  );
  const retired = rows.find((row) => row['article_id'] === y.id);
  expect(retired?.['retired_at']).toEqual(LATER);
});
