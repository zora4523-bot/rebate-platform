// F1-02zzp §9.3 ④：后台新建 / 存草稿写 faq_rank（新版本行），非 help 回 20001，字段顺序按契约；
// 发布复制、公共端可见、审计带值且不带正文。
import { expect, it } from 'vitest';
import { fixture, useHarness } from './faq-harness.ts';
import {
  adminList,
  articleAudits,
  create,
  draft,
  facts,
  invalid,
  list,
  newId,
  noBodyInAudits,
  publicDetail,
  publish,
  publishAgreement,
  save,
  seedArticle,
  send,
  setup,
  snapshot,
  success,
} from './faq-kit.ts';

const h = useHarness(() => import('@couli/db/testing'));

it.each([1, 500, 999])(
  '[AC-F1-02zzp#15] 新建 help 带 faq_rank=%i：版本行、后台详情与列表均带值，审计带值不带正文',
  async (rank) => {
    const f = await setup(h);
    const result = await create(f, { faq_rank: rank, help_section: 'invite' });
    expect(result.versions[0]).toMatchObject({
      version: 1,
      status: 'draft',
      help_section: 'invite',
      faq_rank: rank,
    });
    expect((await success(await send(f, 'detail', result.article_id))).versions[0]).toHaveProperty(
      'faq_rank',
      rank,
    );
    expect((await adminList(f)).items).toEqual([
      expect.objectContaining({ article_id: result.article_id, faq_rank: rank }),
    ]);
    const state = await snapshot(h, f.appId);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      id: result.article_id,
      version: 1,
      help_section: 'invite',
      faq_rank: rank,
    });
    const audits = articleAudits(state);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'article_create',
      before: null,
      after: { faq_rank: rank, help_section: 'invite' },
    });
    noBodyInAudits(state);
  },
);

it('[AC-F1-02zzp#16] 存草稿写新版本行的 faq_rank，省略即 NULL；旧行不变；发布后公共端与 faq=true 可见', async () => {
  const f = await setup(h);
  const { app } = await fixture(h, 'api', f.clock);
  // 直接预置旧版本，独立检测 save，不把 create 的失败当成本例先红原因。
  const id = await seedArticle(h, f.appId, { faq_rank: 5 });
  const first = await success(await send(f, 'detail', id));
  expect(first.versions[0]).toHaveProperty('faq_rank', 5);
  const before = await snapshot(h, f.appId);

  const changed = await save(f, first, { faq_rank: 7 });
  expect(changed.versions[0]).toMatchObject({ version: 2, status: 'draft', faq_rank: 7 });
  expect(changed.versions[1]).toHaveProperty('faq_rank', 5);
  expect((await adminList(f)).items[0]).toMatchObject({
    latest_version: 2,
    current_version: 1,
    faq_rank: 7,
  });
  // 草稿不影响公共端：当前版本仍是 v1。
  expect((await list(app, f.appId, { faq: true })).items).toEqual([
    expect.objectContaining({ article_id: id, version: 1, faq_rank: 5 }),
  ]);
  const checkpoint = await snapshot(h, f.appId);
  expect(checkpoint.rows[0]).toEqual(before.rows[0]);
  expect(checkpoint.rows[1]).toMatchObject({ version: 2, status: 'draft', faq_rank: 7 });
  expect(articleAudits(checkpoint)).toEqual([
    expect.objectContaining({
      action: 'article_draft_save',
      before: expect.objectContaining({ faq_rank: 5 }),
      after: expect.objectContaining({ faq_rank: 7 }),
    }),
  ]);

  const published = await publish(f, changed);
  expect(published.versions[0]).toMatchObject({ version: 2, status: 'published', faq_rank: 7 });
  expect(await publicDetail(app, f.appId, id)).toMatchObject({ version: 2, faq_rank: 7 });
  expect((await list(app, f.appId, { faq: true })).items).toEqual([
    expect.objectContaining({ article_id: id, version: 2, faq_rank: 7 }),
  ]);
  const publishAudit = articleAudits(await snapshot(h, f.appId)).find(
    (row) => row.action === 'article_publish',
  );
  expect(publishAudit).toMatchObject({
    before: expect.objectContaining({ faq_rank: 7 }),
    after: expect.objectContaining({ faq_rank: 7 }),
  });

  const cleared = await save(f, published);
  expect(cleared.versions.map((row) => row.version)).toEqual([3, 2, 1]);
  expect(cleared.versions[0]).not.toHaveProperty('faq_rank');
  expect(cleared.versions[1]).toHaveProperty('faq_rank', 7);
  expect(cleared.versions[2]).toHaveProperty('faq_rank', 5);
  expect((await adminList(f)).items[0]).not.toHaveProperty('faq_rank');
  const after = await snapshot(h, f.appId);
  expect(after.rows[2]).toMatchObject({ version: 3, faq_rank: null });
  const saves = articleAudits(after).filter((row) => row.action === 'article_draft_save');
  expect(saves).toHaveLength(2);
  expect(saves[1]).toMatchObject({
    before: expect.objectContaining({ faq_rank: 7 }),
    after: expect.objectContaining({ faq_rank: null }),
  });
  noBodyInAudits(after);

  const republished = await publish(f, cleared);
  expect(republished.versions[0]).not.toHaveProperty('faq_rank');
  expect(await publicDetail(app, f.appId, id)).not.toHaveProperty('faq_rank');
  expect((await list(app, f.appId, { faq: true })).items).toEqual([]);
  expect(await publicDetail(app, f.appId, id, 2)).toHaveProperty('faq_rank', 7);
  expect(await publicDetail(app, f.appId, id, 1)).toHaveProperty('faq_rank', 5);
});

it.each(['rule', 'notice'] as const)(
  '[AC-F1-02zzp#17] %s 新建和存草稿带 faq_rank 均 20001 fields=[faq_rank]（不静默丢弃），库和审计不变',
  async (category) => {
    const f = await setup(h);
    const id = await seedArticle(h, f.appId, { category, status: 'draft', published_at: null });
    const before = await snapshot(h, f.appId);
    await invalid(
      await send(f, 'create', '', {
        article_id: newId(),
        category,
        ...draft({ faq_rank: 1 }),
      }),
      ['faq_rank'],
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
    await invalid(
      await send(f, 'save', id, { ...draft({ faq_rank: 999 }), expected_row_version: 0 }),
      ['faq_rank'],
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it.each(['create', 'save'] as const)(
  '[AC-F1-02zzp#18] %s 同时标题违禁、公告缺截止、子分类与 faq_rank 非法：fields 按契约排列且无副作用',
  async (op) => {
    const f = await setup(h);
    const id = newId();
    if (op === 'save')
      await seedArticle(h, f.appId, {
        id,
        category: 'notice',
        status: 'draft',
        published_at: null,
      });
    const before = await snapshot(h, f.appId);
    const target =
      op === 'create' ? { article_id: id, category: 'notice' } : { expected_row_version: 0 };
    const wrong = {
      title: '全网最低',
      notice_closable: false,
      help_section: 'invite',
      faq_rank: 3,
    };
    await invalid(await send(f, op, id, { ...draft(wrong), ...target }), [
      'title',
      'notice_end_at',
      'help_section',
      'faq_rank',
      '全网最低',
    ]);
    expect(await snapshot(h, f.appId)).toEqual(before);
    const iframe = JSON.stringify({ type: 'doc', content: [{ type: 'iframe' }] });
    await invalid(await send(f, op, id, { ...draft({ ...wrong, body: iframe }), ...target }), [
      'title',
      'body',
      'notice_end_at',
      'help_section',
      'faq_rank',
      '全网最低',
      'body.content[0].type',
    ]);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-F1-02zzp#19] faq_rank 越界或类型不对由契约拒绝（20001、无写入）；1 与 999 两端可存', async () => {
  const f = await setup(h);
  const id = await seedArticle(h, f.appId, { status: 'draft', published_at: null });
  const before = await snapshot(h, f.appId);
  for (const bad of [0, 1000, -1, 1.5, null, '3']) {
    const payload = draft({ faq_rank: bad });
    await invalid(
      await send(f, 'create', '', { article_id: newId(), category: 'help', ...payload }),
    );
    await invalid(await send(f, 'save', id, { ...payload, expected_row_version: 0 }));
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
  const low = await create(f, { faq_rank: 1 });
  expect(low.versions[0]).toHaveProperty('faq_rank', 1);
  const article = await success(await send(f, 'detail', id));
  const high = await save(f, article, { faq_rank: 999 });
  expect(high.versions[0]).toMatchObject({ version: 2, faq_rank: 999 });
});

it('[AC-F1-02zzp#20] 发布与整篇下线保留每版 faq_rank，审计前后都含该版值且无正文', async () => {
  const f = await setup(h);
  const { app } = await fixture(h, 'api', f.clock);
  const id = await seedArticle(h, f.appId, { faq_rank: 3 });
  await seedArticle(h, f.appId, {
    id,
    version: 2,
    faq_rank: 9,
    status: 'draft',
    published_at: null,
    row_version: 1,
  });
  const initial = await success(await send(f, 'detail', id));
  const published = await publish(f, initial);
  expect(published.versions.map((row) => [row.version, row.faq_rank])).toEqual([
    [2, 9],
    [1, 3],
  ]);
  expect((await list(app, f.appId, { faq: true })).items).toEqual([
    expect.objectContaining({ article_id: id, version: 2, faq_rank: 9 }),
  ]);
  const checkpoint = await snapshot(h, f.appId);
  expect(checkpoint.rows.map((row) => row.faq_rank)).toEqual([3, 9]);
  expect(articleAudits(checkpoint)).toEqual([
    expect.objectContaining({
      action: 'article_publish',
      before: expect.objectContaining({ faq_rank: 9 }),
      after: expect.objectContaining({ faq_rank: 9 }),
    }),
  ]);
  const offline = await success(
    await send(f, 'offline', id, { expected_row_version: published.row_version }),
  );
  expect(offline.versions.map((row) => [row.version, row.status, row.faq_rank])).toEqual([
    [2, 'offline', 9],
    [1, 'offline', 3],
  ]);
  const after = await snapshot(h, f.appId);
  expect(after.rows.map((row) => row.faq_rank)).toEqual([3, 9]);
  const audit = after.audits.find((row) => row.action === 'article_offline')!;
  for (const [version, faq_rank] of [
    [1, 3],
    [2, 9],
  ] as const) {
    expect(facts(audit.before)).toContainEqual(
      expect.objectContaining({ version, faq_rank, status: 'published' }),
    );
    expect(facts(audit.after)).toContainEqual(
      expect.objectContaining({ version, faq_rank, status: 'offline' }),
    );
  }
  noBodyInAudits(after);
  expect((await list(app, f.appId, { faq: true })).items).toEqual([]);
});

it('[AC-F1-02zzp#21] 省略 faq_rank 的新建与协议发布生成的文章为 NULL 且各端无键；带值的才返回', async () => {
  const f = await setup(h);
  const { app } = await fixture(h, 'api', f.clock);
  for (const category of ['help', 'rule', 'notice'] as const) {
    const article = await create(f, { category });
    expect(article.versions[0]).not.toHaveProperty('faq_rank');
    expect(
      (await success(await send(f, 'detail', article.article_id))).versions[0],
    ).not.toHaveProperty('faq_rank');
  }
  await publishAgreement(h, f);
  const before = await snapshot(h, f.appId);
  expect(before.rows).toHaveLength(4);
  for (const row of before.rows) expect(row.faq_rank).toBeNull();
  const agreement = before.rows.find((row) => row.category === 'agreement')!;
  expect(agreement).toMatchObject({ status: 'published', faq_rank: null });
  expect(await publicDetail(app, f.appId, agreement.id)).not.toHaveProperty('faq_rank');
  const tagged = await create(f, { faq_rank: 42 });
  const page = await adminList(f);
  expect(page.items).toHaveLength(5);
  for (const row of page.items) {
    if (row.article_id === tagged.article_id) expect(row).toHaveProperty('faq_rank', 42);
    else expect(row).not.toHaveProperty('faq_rank');
  }
});
