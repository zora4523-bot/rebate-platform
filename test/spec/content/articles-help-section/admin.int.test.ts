import { expect, it } from 'vitest';
import { fixture, useHarness } from './harness.ts';
import {
  adminList,
  articleAudits,
  create,
  draft,
  invalid,
  list,
  newId,
  publicDetail,
  publish,
  publishAgreement,
  save,
  seedArticle,
  send,
  setup,
  snapshot,
  success,
  type Section,
} from './kit.ts';

const h = useHarness(() => import('@couli/db/testing'));
const sections: Section[] = [
  'getting_started',
  'rebate_settlement',
  'orders_claims',
  'withdraw',
  'invite',
  'account_privacy',
];

it.each(sections)(
  '[AC-F1-02zs#7] 新建 help 保存 %s，后台详情和列表均带值，审计保留值不带正文',
  async (section) => {
    const f = await setup(h);
    const result = await create(f, { help_section: section });
    expect(result.versions[0]).toMatchObject({
      version: 1,
      status: 'draft',
      help_section: section,
    });
    expect((await success(await send(f, 'detail', result.article_id))).versions[0]).toHaveProperty(
      'help_section',
      section,
    );
    expect((await adminList(f)).items).toEqual([
      expect.objectContaining({ article_id: result.article_id, help_section: section }),
    ]);
    const state = await snapshot(h, f.appId);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      id: result.article_id,
      version: 1,
      help_section: section,
    });
    const audits = articleAudits(state);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'article_create',
      before: null,
      after: { help_section: section },
    });
    expect(audits[0]!.after).not.toHaveProperty('body');
  },
);

it('[AC-F1-02zs#8] 存草稿写新值，省略再存即 NULL；旧行不变、后台最新值与公共当前值独立', async () => {
  const f = await setup(h);
  const { app } = await fixture(h, 'api', f.clock);
  // 直接预置旧版本，独立检测 save，不把 create 的失败当成本例先红原因。
  const id = await seedArticle(h, f.appId, { help_section: 'invite' });
  const first = await success(await send(f, 'detail', id));
  const before = await snapshot(h, f.appId);
  const changed = await save(f, first, { help_section: 'withdraw' });
  expect(changed.versions[0]).toMatchObject({
    version: 2,
    status: 'draft',
    help_section: 'withdraw',
  });
  expect(changed.versions[1]).toHaveProperty('help_section', 'invite');
  expect((await adminList(f)).items[0]).toMatchObject({
    latest_version: 2,
    current_version: 1,
    help_section: 'withdraw',
  });
  expect(
    (await list(app, f.appId, { help_section: 'invite' })).items.map((row) => row.article_id),
  ).toEqual([id]);
  expect((await list(app, f.appId, { help_section: 'withdraw' })).items).toEqual([]);
  const checkpoint = await snapshot(h, f.appId);
  expect(checkpoint.rows[0]).toEqual(before.rows[0]);
  expect(checkpoint.rows[1]).toMatchObject({ version: 2, help_section: 'withdraw' });
  expect(articleAudits(checkpoint)).toHaveLength(1);
  expect(articleAudits(checkpoint)[0]).toMatchObject({
    action: 'article_draft_save',
    before: { help_section: 'invite' },
    after: { help_section: 'withdraw' },
  });
  const cleared = await save(f, changed);
  expect(cleared.versions.map((row) => row.version)).toEqual([3, 2, 1]);
  expect(cleared.versions[0]).not.toHaveProperty('help_section');
  expect(cleared.versions[1]).toHaveProperty('help_section', 'withdraw');
  expect(cleared.versions[2]).toHaveProperty('help_section', 'invite');
  expect((await adminList(f)).items[0]).not.toHaveProperty('help_section');
  const after = await snapshot(h, f.appId);
  expect(after.rows.slice(0, 2)).toEqual(checkpoint.rows);
  expect(after.rows[2]).toMatchObject({ version: 3, help_section: null });
  expect(articleAudits(after)).toHaveLength(2);
  expect(articleAudits(after)[1]).toMatchObject({
    before: { help_section: 'withdraw' },
    after: { help_section: null },
  });
  for (const audit of articleAudits(after)) {
    expect(audit.before).not.toHaveProperty('body');
    expect(audit.after).not.toHaveProperty('body');
  }
  const published = await publish(f, cleared);
  expect(published.versions[0]).not.toHaveProperty('help_section');
  expect((await list(app, f.appId, { help_section: 'invite' })).items).toEqual([]);
  expect(await publicDetail(app, f.appId, id)).not.toHaveProperty('help_section');
  expect(await publicDetail(app, f.appId, id, 1)).toHaveProperty('help_section', 'invite');
});

it.each(['rule', 'notice'] as const)(
  '[AC-F1-02zs#9] %s 新建和存稿带子分类均 20001，库和审计不变',
  async (category) => {
    const f = await setup(h);
    const id = await seedArticle(h, f.appId, { category, status: 'draft', published_at: null });
    const before = await snapshot(h, f.appId);
    await invalid(
      await send(f, 'create', '', {
        article_id: newId(),
        category,
        ...draft({ help_section: 'invite' }),
      }),
      ['help_section'],
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
    await invalid(
      await send(f, 'save', id, { ...draft({ help_section: 'invite' }), expected_row_version: 0 }),
      ['help_section'],
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it.each(['create', 'save'] as const)(
  '[AC-F1-02zs#10] %s 同时标题违禁、公告缺截止与子分类非法，fields 按契约排列且无副作用',
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
    const payload = {
      ...draft({ title: '全网最低', notice_closable: false, help_section: 'invite' }),
      ...(op === 'create' ? { article_id: id, category: 'notice' } : { expected_row_version: 0 }),
    };
    await invalid(await send(f, op, id, payload), [
      'title',
      'notice_end_at',
      'help_section',
      '全网最低',
    ]);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-F1-02zs#11] 发布与整篇下线保留每版子分类，审计前后都含该版值且无正文', async () => {
  const f = await setup(h);
  const id = await seedArticle(h, f.appId, { help_section: 'invite' });
  await seedArticle(h, f.appId, {
    id,
    version: 2,
    help_section: 'withdraw',
    status: 'draft',
    published_at: null,
    row_version: 1,
  });
  const initial = await success(await send(f, 'detail', id));
  const published = await publish(f, initial);
  expect(published.versions.map((row) => [row.version, row.help_section])).toEqual([
    [2, 'withdraw'],
    [1, 'invite'],
  ]);
  const checkpoint = await snapshot(h, f.appId);
  expect(checkpoint.rows.map((row) => row.help_section)).toEqual(['invite', 'withdraw']);
  expect(articleAudits(checkpoint)).toHaveLength(1);
  expect(articleAudits(checkpoint)[0]).toMatchObject({
    action: 'article_publish',
    before: { help_section: 'withdraw' },
    after: { help_section: 'withdraw' },
  });
  const offline = await success(
    await send(f, 'offline', id, { expected_row_version: published.row_version }),
  );
  expect(offline.versions.map((row) => [row.version, row.status, row.help_section])).toEqual([
    [2, 'offline', 'withdraw'],
    [1, 'offline', 'invite'],
  ]);
  const after = await snapshot(h, f.appId);
  expect(after.rows.map((row) => row.help_section)).toEqual(['invite', 'withdraw']);
  expect(articleAudits(after)).toHaveLength(2);
  const audit = after.audits.find((row) => row.action === 'article_offline')!;
  // 下线审计包含多版本；不固定容器键名，只检查每版的前后事实。
  function facts(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) return value.flatMap(facts);
    if (value === null || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    return [...('version' in row ? [row] : []), ...Object.values(row).flatMap(facts)];
  }
  for (const [version, help_section] of [
    [1, 'invite'],
    [2, 'withdraw'],
  ] as const) {
    expect(facts(audit.before)).toContainEqual(
      expect.objectContaining({ version, help_section, status: 'published' }),
    );
    expect(facts(audit.after)).toContainEqual(
      expect.objectContaining({ version, help_section, status: 'offline' }),
    );
  }
  for (const row of after.audits) {
    expect(
      JSON.stringify([row.before, row.after], (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('"body"');
  }
});

it('[AC-F1-02zs#12] 各分类有值才返回，省略新建为 NULL，协议发布生成的文章也为 NULL', async () => {
  const f = await setup(h);
  const { app } = await fixture(h, 'api', f.clock);
  for (const category of ['help', 'rule', 'notice'] as const) {
    const article = await create(f, { category });
    expect(article.versions[0]).not.toHaveProperty('help_section');
    expect(
      (await success(await send(f, 'detail', article.article_id))).versions[0],
    ).not.toHaveProperty('help_section');
  }
  await publishAgreement(h, f);
  const before = await snapshot(h, f.appId);
  expect(before.rows).toHaveLength(4);
  for (const row of before.rows) expect(row.help_section).toBeNull();
  const agreement = before.rows.find((row) => row.category === 'agreement')!;
  expect(agreement).toMatchObject({ status: 'published', help_section: null });
  expect(await publicDetail(app, f.appId, agreement.id)).not.toHaveProperty('help_section');
  expect((await success(await send(f, 'detail', agreement.id))).versions[0]).not.toHaveProperty(
    'help_section',
  );
  const tagged = await create(f, { help_section: 'invite' });
  const page = await adminList(f);
  expect(page.items).toHaveLength(5);
  for (const row of page.items) {
    if (row.article_id === tagged.article_id) expect(row).toHaveProperty('help_section', 'invite');
    else expect(row).not.toHaveProperty('help_section');
  }
});
