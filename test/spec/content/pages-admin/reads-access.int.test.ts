import { expect, it, vi } from 'vitest';
import { AdminOperationGuard } from '../../../../apps/api/src/modules/platform/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  detail,
  fields,
  member,
  publish,
  rejected,
  ROUTES,
  save,
  sections,
  seedDraft,
  send,
  setup,
  snapshot,
  success,
  version,
  WRITES,
  type Operation,
  type PageList,
  type VersionList,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-09f#10] 页面按 key 分页、total 不随页变，版本降序分页且列表不含 sections，读取不审计', async () => {
  const f = await setup(h);
  for (const key of ['home', 'custom:z', 'custom:a']) await save(f, key, 0);
  for (let revision = 1; revision < 4; revision += 1)
    await save(f, 'home', revision, sections(`v${revision + 1}`));
  await publish(f, 'home', 4, 2);
  await publish(f, 'home', 5, 3, 10);
  f.clock.advanceMs(1000);
  await success(await send(f, 'rollback', 'home', { version: 3, expected_revision: 6 }));
  const before = await snapshot(h, f.appId);
  const first = await success<PageList>(
    await send(f, 'list', 'home', undefined, { query: '?page=1&page_size=2' }),
  );
  const second = await success<PageList>(
    await send(f, 'list', 'home', undefined, { query: '?page=2&page_size=2' }),
  );
  expect(first).toMatchObject({ page: 1, page_size: 2, total: 3 });
  expect(first.items.map((p) => p.page_key)).toEqual(['custom:a', 'custom:z']);
  expect(second).toMatchObject({ page: 2, page_size: 2, total: 3 });
  expect(second.items).toEqual([await detail(f)]);
  expect(
    (
      await success<PageList>(
        await send(f, 'list', 'home', undefined, { query: '?page=3&page_size=2' }),
      )
    ).items,
  ).toEqual([]);
  const versions = [];
  for (const page of [1, 2]) {
    const data = await success<VersionList>(
      await send(f, 'versions', 'home', undefined, { query: `?page=${page}&page_size=2` }),
    );
    expect(data).toMatchObject({ page, page_size: 2, total: 4 });
    versions.push(...data.items);
  }
  expect(versions.map((v) => [v.version, v.status])).toEqual([
    [4, 'draft'],
    [3, 'rolled_back'],
    [2, 'published'],
    [1, 'draft'],
  ]);
  for (const item of versions) expect(item).not.toHaveProperty('sections');
  expect(await version(f, 'home', 2)).toMatchObject({ sections: sections('v2'), page_key: 'home' });
  expect(await detail(f)).toMatchObject({ latest_version: 4, current_version: 2, revision: 7 });
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-09f#11] 作者、发布人、更新人动态关联登录名，统计值原样返回，空发布人保持 null', async () => {
  const f = await setup(h);
  await save(f, 'home', 0);
  await publish(f, 'home', 1, 1);
  await save(f, 'home', 2);
  await h.db
    .updateTable('page_versions')
    .set({ render_count: 31n, error_count: 7n })
    .where('app_id', '=', f.appId)
    .where('page_key', '=', 'home')
    .where('version', '=', 1)
    .execute();
  const changed = 'pages_renamed_admin';
  await h.db
    .updateTable('admin_users')
    .set({ login_name: changed })
    .where('id', '=', f.actor.id)
    .execute();
  const before = await snapshot(h, f.appId);
  expect(await detail(f)).toMatchObject({ updated_by: changed });
  expect((await success<PageList>(await send(f, 'list'))).items[0]).toMatchObject({
    updated_by: changed,
  });
  expect(await version(f)).toMatchObject({
    created_by: changed,
    publisher: changed,
    render_count: 31,
    error_count: 7,
  });
  expect(await version(f, 'home', 2)).toMatchObject({
    created_by: changed,
    publisher: null,
    publish_at: null,
  });
  const list = await success<VersionList>(await send(f, 'versions'));
  expect(list.items).toMatchObject([
    { created_by: changed, publisher: null },
    { created_by: changed, publisher: changed, render_count: 31, error_count: 7 },
  ]);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-09f#12] 不存在的页及版本返回 30701，空锁行不算已保存页面且列表不显示', async () => {
  const f = await setup(h);
  await h.db
    .insertInto('pages')
    .values({
      app_id: f.appId,
      page_key: 'custom:empty',
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  for (const key of ['custom:absent', 'custom:empty']) {
    const before = await snapshot(h, f.appId);
    for (const op of ['detail', 'versions', 'version'] as const)
      await rejected(await send(f, op, key), 30701);
    for (const op of ['publish', 'gray', 'rollback'] as const) {
      const body =
        op === 'gray'
          ? { gray_percent: 10, expected_revision: 0 }
          : op === 'publish'
            ? { version: 1, gray_percent: 100, expected_revision: 0 }
            : { version: 1, expected_revision: 0 };
      await rejected(await send(f, op, key, body), 30701);
    }
    expect(await snapshot(h, f.appId)).toEqual(before);
  }
  expect((await success<PageList>(await send(f, 'list'))).total).toBe(0);
  await save(f, 'home', 0);
  const before = await snapshot(h, f.appId);
  await rejected(await send(f, 'version', 'home', undefined, { version: 99 }), 30701);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

const BODIES = {
  save: { sections: sections(), expected_revision: 4 },
  publish: { version: 3, gray_percent: 100, expected_revision: 4 },
  gray: { gray_percent: 50, expected_revision: 4 },
  rollback: { version: 2, expected_revision: 4 },
};

it.each(['detail', 'versions', 'version', ...WRITES] as const)(
  '[AC-F1-09f#32] %s 拒绝大写、空名称和超长 page_key，fields 精确且不留写入',
  async (op) => {
    const f = await setup(h);
    const before = await snapshot(h, f.appId);
    const body =
      op in BODIES ? { ...BODIES[op as keyof typeof BODIES], expected_revision: 0 } : undefined;
    for (const key of ['Home', 'custom:', `custom:${'a'.repeat(58)}`]) {
      f.clock.advanceMs(1000);
      await fields(await send(f, op, key, body), ['page_key']);
      expect(await snapshot(h, f.appId)).toEqual(before);
    }
  },
);

it.each(Object.keys(ROUTES) as Operation[])(
  '[AC-F1-09f#13] %s 无登录为 10001、缺 content.page 为 10403，不能凭其他内容权限访问',
  async (op) => {
    const f = await setup(h);
    await save(f, 'home', 0);
    await publish(f, 'home', 1, 1);
    await save(f, 'home', 2);
    await publish(f, 'home', 3, 2, 10);
    const caller = await member(h, f, ['content.article']);
    const body = op in BODIES ? BODIES[op as keyof typeof BODIES] : undefined;
    const before = await snapshot(h, f.appId);
    await rejected(await send(f, op, 'home', body, { token: null }), 10001);
    expect(await snapshot(h, f.appId)).toEqual(before);
    await rejected(await send(f, op, 'home', body, { token: caller.token }), 10403);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-F1-09f#14] app_id 只取 actor：另一应用的同名页面、revision、版本与审计均隔离', async () => {
  const a = await setup(h);
  const b = await setup(h);
  await save(a, 'home', 0, sections('app_a'));
  await publish(a, 'home', 1, 1);
  const original = await snapshot(h, a.appId);
  const spoof = { 'x-app-id': a.appId };
  expect(
    (await success<PageList>(await send(b, 'list', 'home', undefined, { headers: spoof }))).total,
  ).toBe(0);
  for (const op of ['detail', 'versions', 'version'] as const)
    await rejected(await send(b, op, 'home', undefined, { headers: spoof }), 30701);
  for (const op of ['publish', 'gray', 'rollback'] as const) {
    const body =
      op === 'gray'
        ? { gray_percent: 10, expected_revision: 0 }
        : op === 'publish'
          ? { version: 1, gray_percent: 100, expected_revision: 0 }
          : { version: 1, expected_revision: 0 };
    const before = await snapshot(h, b.appId);
    await rejected(await send(b, op, 'home', body, { headers: spoof }), 30701);
    expect(await snapshot(h, b.appId)).toEqual(before);
  }
  await success(
    await send(
      b,
      'save',
      'home',
      { sections: sections('app_b'), expected_revision: 0 },
      { headers: spoof },
    ),
  );
  expect(await version(b)).toMatchObject({ version: 1, sections: sections('app_b') });
  expect(await snapshot(h, a.appId)).toEqual(original);
});

it.each(['publish', 'gray'] as const)(
  '[AC-F1-09f#15] %s 的 gray_percent 路由边界 0 / 101 / 非整数拒绝且不写库',
  async (op) => {
    const f = await setup(h);
    await save(f, 'home', 0);
    await publish(f, 'home', 1, 1);
    await save(f, 'home', 2);
    if (op === 'gray') await publish(f, 'home', 3, 2, 10);
    const before = await snapshot(h, f.appId);
    for (const percent of [0, 101, 1.5]) {
      const body =
        op === 'gray'
          ? { gray_percent: percent, expected_revision: 4 }
          : { version: 2, gray_percent: percent, expected_revision: 3 };
      await rejected(await send(f, op, 'home', body), 20001);
      expect(await snapshot(h, f.appId)).toEqual(before);
    }
  },
);

it.each(WRITES)(
  '[AC-F1-09f#16] %s 先检查页级 revision，冲突不改任何数据且不用状态错误覆盖',
  async (op) => {
    const f = await setup(h);
    await save(f, 'home', 0);
    const before = await snapshot(h, f.appId);
    const body =
      op === 'save'
        ? { sections: sections(), expected_revision: 0 }
        : op === 'gray'
          ? { gray_percent: 50, expected_revision: 0 }
          : op === 'publish'
            ? { version: 99, gray_percent: 100, expected_revision: 0 }
            : { version: 99, expected_revision: 0 };
    await rejected(await send(f, op, 'home', body), 20902, { resource: 'page' });
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-F1-09f#17] 空 updated_by UUID 显示 null，不把创建者填作最后更新者', async () => {
  const f = await setup(h);
  await seedDraft(h, f, 'home', sections());
  await h.db
    .updateTable('pages')
    .set({ updated_by_admin_id: null })
    .where('app_id', '=', f.appId)
    .where('page_key', '=', 'home')
    .execute();
  expect(await detail(f)).toMatchObject({ updated_by: null });
  expect((await success<PageList>(await send(f, 'list'))).items[0]).toMatchObject({
    updated_by: null,
  });
});

it('[AC-F1-09f#18] 列表和版本列表拒绝超过 200 的 page_size', async () => {
  const f = await setup(h);
  await save(f, 'home', 0);
  const before = await snapshot(h, f.appId);
  for (const op of ['list', 'versions'] as const) {
    await rejected(await send(f, op, 'home', undefined, { query: '?page=1&page_size=201' }), 20001);
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-09f#31] 八条路由逐次经过 content.page 守卫，四条 GET 明确 readOnly，写入不使用只读豁免', async () => {
  const f = await setup(h);
  await seedDraft(h, f, 'home', sections());
  const app = f.app as unknown as { get(token: typeof AdminOperationGuard): AdminOperationGuard };
  const guard = app.get(AdminOperationGuard);
  const spy = vi.spyOn(guard, 'run');
  try {
    for (const op of ['list', 'detail', 'versions', 'version'] as const) {
      spy.mockClear();
      await success(await send(f, op));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatchObject({ permission: 'content.page', readOnly: true });
    }
    for (const [op, body] of [
      ['save', { sections: sections('second'), expected_revision: 1 }],
      ['publish', { version: 1, gray_percent: 100, expected_revision: 2 }],
      ['publish', { version: 2, gray_percent: 10, expected_revision: 3 }],
      ['gray', { gray_percent: 50, expected_revision: 4 }],
      ['rollback', { version: 2, expected_revision: 5 }],
    ] as const) {
      f.clock.advanceMs(1000);
      spy.mockClear();
      await success(await send(f, op, 'home', body));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0].permission).toBe('content.page');
      expect(spy.mock.calls[0]![0].readOnly).not.toBe(true);
    }
  } finally {
    spy.mockRestore();
  }
});
