import { expect, it, vi } from 'vitest';
import { transitionArticleVersion } from '../../../../packages/domain/src/state-machines/article-version.gen.ts';
import { useHarness } from './harness.ts';
import {
  audit,
  body,
  conflict,
  create,
  detail,
  draft,
  failAudit,
  fields,
  instant,
  list,
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

// 在本文件提升注册，静态导入和应用拿到同一个 spy；仍执行真实状态迁移。
vi.mock('../../../../packages/domain/src/state-machines/article-version.gen.ts', { spy: true });

const h = useHarness(() => import('@couli/db/testing'));

it('[AC-F1-02w#33] 新建与存稿走 A1、发布走 A2、整篇下线每个 published 都走 A3', async () => {
  const f = await setup(h);
  const transition = vi.mocked(transitionArticleVersion);
  transition.mockClear();
  const id = (await create(f)).article_id;
  expect(transition).toHaveBeenCalledWith(null, 'DRAFT_SAVED');
  transition.mockClear();
  await publish(f, id, 0, 1);
  expect(transition).toHaveBeenCalledWith('draft', 'PUBLISH');
  transition.mockClear();
  await save(f, id, 1);
  expect(transition).toHaveBeenCalledWith(null, 'DRAFT_SAVED');
  await publish(f, id, 2, 2, new Date(f.clock.now().getTime() + 60_000).toISOString());
  transition.mockClear();
  f.clock.advanceMs(1000);
  expect(await success(await send(f, 'offline', id, { expected_row_version: 3 }))).toMatchObject({
    current_version: null,
  });
  expect(
    transition.mock.calls.filter(([from, event]) => from === 'published' && event === 'OFFLINE')
      .length,
  ).toBeGreaterThanOrEqual(2);
});

it('[AC-F1-02w#1] 新建为 v1 draft / CAS 0，显式 Clock 时间、非公告字段归一，重试无第二行', async () => {
  const f = await setup(h);
  const id = newId();
  const before = await snapshot(h, f.appId);
  const result = await create(f, id, {
    notice_closable: false,
    notice_end_at: '2026-11-01T00:00:00Z',
  });
  expect(result).toMatchObject({
    article_id: id,
    category: 'help',
    row_version: 0,
    current_version: null,
  });
  expect(result.versions).toHaveLength(1);
  expect(result.versions[0]).toMatchObject({
    version: 1,
    status: 'draft',
    ...draft(),
    published_at: null,
    notice_closable: true,
    notice_end_at: null,
    notice_content_version: 1,
  });
  const state = await snapshot(h, f.appId);
  expect(state.rows).toHaveLength(1);
  expect(state.rows[0]).toMatchObject({
    app_id: f.appId,
    row_version: 0,
    created_at: f.clock.now(),
    updated_at: f.clock.now(),
  });
  expect(instant(result.versions[0]!.created_at)).toBe(f.clock.now().toISOString());
  const a = await audit(h, f, before, 'create', id);
  expect(a.after).toMatchObject({
    version: 1,
    status: 'draft',
    row_version: 0,
    published_at: null,
  });
  f.clock.advanceMs(1000);
  await conflict(await send(f, 'create', id, { article_id: id, category: 'help', ...draft() }));
  expect(await snapshot(h, f.appId)).toEqual(state);
});

it('[AC-F1-02w#2] 草稿另插 v2、CAS 递增，旧行全部不变；旧 CAS 拒绝且无副作用', async () => {
  const f = await setup(h);
  const id = (await create(f)).article_id;
  const before = await snapshot(h, f.appId);
  const result = await save(f, id, 0, { title: '第二版说明', body: body('第二版正文') });
  expect(result).toMatchObject({ row_version: 1, current_version: null });
  expect(result.versions.map((v) => [v.version, v.status])).toEqual([
    [2, 'draft'],
    [1, 'draft'],
  ]);
  expect(result.versions[0]).toMatchObject({ title: '第二版说明', body: body('第二版正文') });
  const after = await snapshot(h, f.appId);
  expect(after.rows[0]).toEqual(before.rows[0]);
  expect(after.rows[1]).toMatchObject({
    row_version: 1,
    created_at: f.clock.now(),
    updated_at: f.clock.now(),
  });
  const a = await audit(h, f, before, 'save', id);
  expect(a.before).toMatchObject({
    version: 1,
    status: 'draft',
    row_version: 0,
    published_at: null,
  });
  expect(a.after).toMatchObject({
    version: 2,
    status: 'draft',
    row_version: 1,
    published_at: null,
  });
  await conflict(await send(f, 'save', id, { ...draft(), expected_row_version: 0 }));
  expect(await snapshot(h, f.appId)).toEqual(after);
});

it('[AC-F1-02w#3] 同 expected 并发保存恰一成功一冲突，只产生一个版本和一条审计', async () => {
  const f = await setup(h);
  const id = (await create(f)).article_id;
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(1000);
  const attempts = await Promise.all(
    ['甲版', '乙版'].map((title) =>
      send(f, 'save', id, {
        ...draft({ title }),
        expected_row_version: 0,
      }),
    ),
  );
  expect(attempts.map((s) => s.response.statusCode).sort()).toEqual([200, 409]);
  const winner = await success(attempts.find((s) => s.response.statusCode === 200)!);
  await conflict(attempts.find((s) => s.response.statusCode === 409)!);
  expect(winner).toMatchObject({ row_version: 1 });
  const after = await snapshot(h, f.appId);
  expect(after.rows).toHaveLength(2);
  expect(after.rows[0]).toEqual(before.rows[0]);
  expect(after.rows[1]).toMatchObject({
    version: 2,
    title: winner.versions[0]!.title,
    row_version: 1,
  });
  await audit(h, f, before, 'save', id);
});

it('[AC-F1-02w#4] 只允许发布最新草稿；立即发布用 Clock，重放先 CAS 后状态', async () => {
  const f = await setup(h);
  const id = (await create(f)).article_id;
  await save(f, id, 0);
  const before = await snapshot(h, f.appId);
  for (const version of [1, 99]) {
    await fields(await send(f, 'publish', id, { version, expected_row_version: 1 }), ['version']);
    expect(await snapshot(h, f.appId)).toEqual(before);
  }
  const result = await publish(f, id, 1, 2);
  expect(result).toMatchObject({ row_version: 2, current_version: 2 });
  expect(result.versions[0]).toMatchObject({ version: 2, status: 'published' });
  expect(instant(result.versions[0]!.published_at)).toBe(f.clock.now().toISOString());
  const a = await audit(h, f, before, 'publish', id);
  expect(a.before).toMatchObject({
    version: 2,
    status: 'draft',
    row_version: 1,
    published_at: null,
  });
  expect(a.after).toMatchObject({ version: 2, status: 'published', row_version: 2 });
  expect(instant((a.after as { published_at: string }).published_at)).toBe(
    f.clock.now().toISOString(),
  );
  const after = await snapshot(h, f.appId);
  expect(after.rows[0]).toEqual(before.rows[0]);
  expect(after.rows[1]).toMatchObject({
    row_version: 2,
    published_at: f.clock.now(),
    updated_at: f.clock.now(),
  });
  await conflict(await send(f, 'publish', id, { version: 2, expected_row_version: 1 }));
  await fields(await send(f, 'publish', id, { version: 2, expected_row_version: 2 }), ['version']);
  expect(await snapshot(h, f.appId)).toEqual(after);
});

it('[AC-F1-02w#5] 定时发布保留旧 published，current 在边界生效且按最大 version 而非发布时间', async () => {
  const f = await setup(h);
  const id = (await create(f)).article_id;
  await publish(f, id, 0, 1);
  const old = (await snapshot(h, f.appId)).rows[0];
  await save(f, id, 1);
  const due = new Date(f.clock.now().getTime() + 60_000);
  expect(await publish(f, id, 2, 2, due.toISOString())).toMatchObject({
    row_version: 3,
    current_version: 1,
  });
  expect((await snapshot(h, f.appId)).rows[0]).toEqual(old);
  f.clock.set(new Date(due.getTime() - 1));
  expect((await detail(f, id)).current_version).toBe(1);
  expect((await list(f)).items[0]).toMatchObject({
    latest_version: 2,
    latest_status: 'published',
    current_version: 1,
  });
  f.clock.set(due);
  expect((await detail(f, id)).current_version).toBe(2);
  expect(instant((await list(f)).items[0]!.published_at)).toBe(due.toISOString());
  await save(f, id, 3);
  const later = new Date(f.clock.now().getTime() + 60_000);
  await publish(f, id, 4, 3, later.toISOString());
  await save(f, id, 5);
  expect(await publish(f, id, 6, 4)).toMatchObject({ current_version: 4, row_version: 7 });
  f.clock.set(later);
  expect((await detail(f, id)).current_version).toBe(4);
});

it('[AC-F1-02w#6] 第一次定时发布在到点前无 current，过去时刻拒绝并回滚', async () => {
  const f = await setup(h);
  const id = (await create(f)).article_id;
  const before = await snapshot(h, f.appId);
  await fields(
    await send(f, 'publish', id, {
      version: 1,
      expected_row_version: 0,
      published_at: new Date(f.clock.now().getTime() - 1).toISOString(),
    }),
    ['published_at'],
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  const due = new Date(f.clock.now().getTime() + 60_000);
  expect(await publish(f, id, 0, 1, due.toISOString())).toMatchObject({
    current_version: null,
    row_version: 1,
  });
  expect((await list(f)).items[0]).toMatchObject({ current_version: null, published_at: null });
  f.clock.set(due);
  expect((await detail(f, id)).current_version).toBe(1);
});

it('[AC-F1-02w#7] 整篇下线包括定时版本，保留草稿内容；CAS 加在最新草稿，审计列出所有受影响版本', async () => {
  const f = await setup(h);
  const id = (await create(f)).article_id;
  await publish(f, id, 0, 1);
  await save(f, id, 1);
  await publish(f, id, 2, 2, new Date(f.clock.now().getTime() + 60_000).toISOString());
  await save(f, id, 3);
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(1000);
  const result = await success(await send(f, 'offline', id, { expected_row_version: 4 }));
  expect(result).toMatchObject({ row_version: 5, current_version: null });
  expect(result.versions.map((v) => [v.version, v.status])).toEqual([
    [3, 'draft'],
    [2, 'offline'],
    [1, 'offline'],
  ]);
  const after = await snapshot(h, f.appId);
  expect(after.rows[2]).toEqual({ ...before.rows[2], row_version: 5, updated_at: f.clock.now() });
  for (let i = 0; i < 2; i += 1) {
    expect(after.rows[i]).toEqual({
      ...before.rows[i],
      status: 'offline',
      updated_at: f.clock.now(),
    });
  }
  const a = await audit(h, f, before, 'offline', id);
  // 审计容器形状未固定，递归找版本事实，不强制数组字段名。
  const facts = (value: unknown): Record<string, unknown>[] => {
    if (Array.isArray(value)) return value.flatMap(facts);
    if (value !== null && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      return [...('version' in row ? [row] : []), ...Object.values(row).flatMap(facts)];
    }
    return [];
  };
  for (const version of [1, 2]) {
    expect(facts(a.before)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version, status: 'published', published_at: expect.any(String) }),
      ]),
    );
    expect(facts(a.after)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version, status: 'offline', published_at: expect.any(String) }),
      ]),
    );
  }
  expect(JSON.stringify(a.after)).toContain('"row_version":5');
  await conflict(await send(f, 'offline', id, { expected_row_version: 4 }));
  await fields(await send(f, 'offline', id, { expected_row_version: 5 }), ['article_id']);
  expect(await snapshot(h, f.appId)).toEqual(after);
});

it('[AC-F1-02w#8] 公告下线补空或未来截止时间，保留更早截止和草稿的截止', async () => {
  const f = await setup(h);
  const id = newId();
  const past = new Date(f.clock.now().getTime() - 60_000);
  const future = new Date(f.clock.now().getTime() + 60_000);
  for (const [version, end, status] of [
    [1, null, 'published'],
    [2, future, 'published'],
    [3, past, 'published'],
    [4, future, 'draft'],
  ] as const) {
    await seedArticle(h, f, id, {
      category: 'notice',
      version,
      status,
      notice_end_at: end,
      published_at: status === 'published' ? future : null,
      row_version: version,
    });
  }
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(1000);
  expect(await success(await send(f, 'offline', id, { expected_row_version: 4 }))).toMatchObject({
    row_version: 5,
    current_version: null,
  });
  const after = await snapshot(h, f.appId);
  expect(after.rows.map((r) => instant(r.notice_end_at))).toEqual([
    f.clock.now().toISOString(),
    f.clock.now().toISOString(),
    past.toISOString(),
    future.toISOString(),
  ]);
  expect(after.rows[3]).toEqual({ ...before.rows[3], row_version: 5, updated_at: f.clock.now() });
  await audit(h, f, before, 'offline', id);
});

it('[AC-F1-02w#9] 没有 published 的纯草稿下线拒绝，无审计和行变化', async () => {
  const f = await setup(h);
  const id = (await create(f)).article_id;
  const before = await snapshot(h, f.appId);
  await fields(await send(f, 'offline', id, { expected_row_version: 0 }), ['article_id']);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-02w#10] 公告内容版本由服务端维护：标题与 true→false 加一，正文、截止及 false→true 不加', async () => {
  const f = await setup(h);
  const id = (await create(f, newId(), { category: 'notice' })).article_id;
  const end = '2026-11-01T00:00:00Z';
  const steps = [
    { title: '第二版说明', notice_end_at: end, notice_closable: true, expected: 2 },
    {
      title: '第二版说明',
      notice_end_at: '2026-12-01T00:00:00Z',
      notice_closable: true,
      expected: 2,
    },
    { title: '第二版说明', notice_end_at: end, notice_closable: false, expected: 3 },
    {
      title: '第二版说明',
      notice_end_at: end,
      notice_closable: false,
      body: body('修改正文'),
      expected: 3,
    },
    { title: '第二版说明', notice_end_at: end, notice_closable: true, expected: 3 },
  ];
  for (const [revision, { expected, ...input }] of steps.entries()) {
    const result = await save(f, id, revision, input);
    expect(result.versions[0]).toMatchObject({
      version: revision + 2,
      notice_content_version: expected,
    });
  }
  expect((await detail(f, id)).versions.at(-1)).toMatchObject({
    notice_content_version: 1,
    notice_closable: true,
  });
});

it.each(['create', 'save', 'publish', 'offline'] as const)(
  '[AC-F1-02w#11] %s 的审计写后故障必须回滚业务行与审计行',
  async (op) => {
    const f = await setup(h);
    const id = newId();
    if (op !== 'create') await create(f, id);
    if (op === 'offline') await publish(f, id, 0, 1);
    const before = await snapshot(h, f.appId);
    const payload = {
      create: { article_id: id, category: 'help', ...draft() },
      save: { ...draft(), expected_row_version: 0 },
      publish: { version: 1, expected_row_version: 0 },
      offline: { expected_row_version: 1 },
    }[op];
    failAudit(f.appId);
    f.clock.advanceMs(1000);
    await rejected(await send(f, op, id, payload), 50001);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);
