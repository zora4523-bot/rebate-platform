// F1-02zd §9: real admin/api entry, PG snapshots, permission guard and editor.
// Only the orchestrator's isolated runner executes this file.
import { createDb, destroyDb } from '@couli/db';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { admin_permission } from '../../../../packages/contracts-ts/src/index.ts';
import { adminDefaultTexts } from '../../../../apps/api/src/modules/content/infra/admin-texts-default.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import {
  KEYS,
  ROOT,
  contract,
  defaults,
  expectedItems,
  harness,
  member,
  readPublic,
  rejected,
  seedItem,
  seedVersion,
  send,
  setup,
  snapshot,
  stepUp,
  success,
  type AdminDict,
  type Harness,
  type ItemPage,
  type Saved,
} from './kit.ts';

// Keep the real lazy loader except in the explicitly marked broken-file test. Wrapping
// before bootstrap also covers providers that capture the loader function itself.
vi.mock(
  '../../../../apps/api/src/modules/content/infra/admin-texts-default.ts',
  async (original) => {
    const actual =
      await original<
        typeof import('../../../../apps/api/src/modules/content/infra/admin-texts-default.ts')
      >();
    return { ...actual, adminDefaultTexts: vi.fn(actual.adminDefaultTexts) };
  },
);

let database: Awaited<ReturnType<(typeof import('@couli/db/testing'))['createTestDatabase']>>;
let redis: Awaited<ReturnType<(typeof import('@couli/db/testing'))['acquireTestRedis']>>;
let db: ReturnType<typeof createDb>;
let h: Harness;
beforeAll(async () => {
  const testing = await import('@couli/db/testing');
  database = await testing.createTestDatabase();
  redis = await testing.acquireTestRedis();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  h = await harness(db, database.urlFor('couli_app'), redis.url);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
});

it('[AC-F1-02zd#1] 无版本和行仍返回全部默认；多点枚举按末点切分，路由解除 planned', async () => {
  const f = await setup(h);
  expect(
    h.app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: '/admin/v1/dict' }),
  ).toBe(true);
  const before = await snapshot(h, f.appId);
  const data = success<AdminDict>(await send(f, 'read'));
  expect(data).toEqual({ version: '0', items: expectedItems() });
  expect(data.items).not.toHaveProperty('admin_dict');
  expect(data.items['admin_adjustments.status']).toHaveProperty('APPROVED', '已生效');
  expect(data.items['union_accounts.last_probe_ok']).toHaveProperty('true', '探测正常');
  expect(data.items['withdrawals.auto_decision.failed_conditions']).toHaveProperty(
    'warn_high_commission',
    '高佣预警',
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  const operation = (await contract()).paths['/admin/v1/dict']!.get!;
  expect(operation.operationId).toBe('adminGetDict');
  expect(operation['x-auth']).toBe('admin');
  expect(operation['x-implementation']).not.toBe('planned');
});

it('[AC-F1-02zd#2] 每键选当前版本以内最新行，null 恢复默认，未来行、未知键和别的 app 不泄漏', async () => {
  const f = await setup(h);
  const other = await setup(h);
  await seedVersion(h, f.appId, '2');
  await seedItem(h, f, KEYS.general, 1, '已过期覆盖');
  await seedItem(h, f, KEYS.general, 2, null);
  await seedItem(h, f, KEYS.general, 3, '未发布覆盖');
  await seedItem(h, f, KEYS.second, 1, '旧探测');
  await seedItem(h, f, KEYS.second, 2, '当前探测');
  await seedItem(h, f, KEYS.second, 3, '未来探测');
  await seedItem(h, f, KEYS.fund, 1, '沿用上一版');
  await seedItem(h, f, KEYS.unknown, 2, 'SQL 注入的未知键');
  await seedItem(h, f, KEYS.public, 2, '用户侧覆盖');
  await seedVersion(h, other.appId, '2');
  await seedItem(h, other, KEYS.second, 2, '别的应用');
  const actual = success<AdminDict>(
    await send(f, 'read', undefined, {
      headers: { 'x-app-id': other.appId },
    }),
  );
  expect(actual).toEqual({
    version: '2',
    items: expectedItems({
      [KEYS.second]: '当前探测',
      [KEYS.fund]: '沿用上一版',
    }),
  });
  expect(success<AdminDict>(await send(other, 'read'))).toEqual({
    version: '2',
    items: expectedItems({ [KEYS.second]: '别的应用' }),
  });
});

it('[AC-F1-02zd#3] 无行、非字符串及未发布版本不应用覆盖；非规范串原样返回并告警', async () => {
  for (const value of [undefined, null, 2, { version: '2' }, '0', '01', 'dict-42']) {
    const f = await setup(h);
    if (value !== undefined) await seedVersion(h, f.appId, value);
    await seedItem(h, f, KEYS.general, 1, '不得下发');
    expect(success<AdminDict>(await send(f, 'read'))).toEqual({
      version: typeof value === 'string' ? value : '0',
      items: expectedItems(),
    });
    if (value === '01' || value === 'dict-42') {
      expect(h.logs.map((line) => JSON.parse(line) as unknown)).toContainEqual(
        expect.objectContaining({ event: 'content_dict_version_invalid', app_id: f.appId }),
      );
    }
  }
});

it('[AC-F1-02zd#4] 每个权限点单独持有都可读，超管可读，无点拒绝，停用拒绝，所有读取不审计', async () => {
  const f = await setup(h);
  const audits = () =>
    h.db.selectFrom('audit_logs').selectAll().where('app_id', '=', f.appId).execute();
  const before = await audits();
  for (const permission of admin_permission) {
    const actor = await member(h, f.appId, [permission]);
    expect(success<AdminDict>(await send(f, 'read', undefined, { token: actor.token }))).toEqual({
      version: '0',
      items: expectedItems(),
    });
  }
  const root = await member(h, f.appId, []);
  await h.db.updateTable('admin_users').set({ is_super: true }).where('id', '=', root.id).execute();
  expect(success<AdminDict>(await send(f, 'read', undefined, { token: root.token })).version).toBe(
    '0',
  );
  const empty = await member(h, f.appId, []);
  rejected(await send(f, 'read', undefined, { token: empty.token }), 10403, {
    reason: 'admin_permission_denied',
  });
  const disabled = await member(h, f.appId, ['dashboard.view']);
  await h.db
    .updateTable('admin_users')
    .set({ status: 'disabled' })
    .where('id', '=', disabled.id)
    .execute();
  rejected(await send(f, 'read', undefined, { token: disabled.token }), 10001);
  expect(await audits()).toEqual(before);
}, 60_000);

it('[AC-F1-02zd#5] 读取不消耗 step-up，资金键权限及动态码拒绝留审计，原 token 仍可写且只用一次', async () => {
  const f = await setup(h);
  const fund = await member(h, f.appId, ['content.fund_terms']);
  const token = await stepUp(h, fund);
  const body = { changes: [{ key: KEYS.fund, text: '待付款确认' }], expected_version: '0' };
  const before = await snapshot(h, f.appId);
  expect(
    success<AdminDict>(await send(f, 'read', undefined, { token: fund.token, stepUp: token }))
      .version,
  ).toBe('0');
  expect(await snapshot(h, f.appId)).toEqual(before);
  for (const [actor, code] of [
    [f.actor, 10403],
    [fund, 10003],
  ] as const) {
    rejected(
      await send(f, 'save', body, { token: actor.token }),
      code,
      code === 10403 ? { reason: 'admin_permission_denied' } : { tier: 'totp' },
    );
    const after = await snapshot(h, f.appId);
    expect(after.items).toEqual(before.items);
    expect(after.config).toEqual(before.config);
    expect(after.audits.at(-1)).toMatchObject({
      action: 'dict_items_denied',
      admin_id: actor.id,
      after: { keys: [KEYS.fund] },
    });
    expect(Object.values(after.audits.at(-1)!.after as object)).toContain(code);
  }
  expect((await snapshot(h, f.appId)).audits).toHaveLength(before.audits.length + 2);
  expect(success<Saved>(await send(f, 'save', body, { token: fund.token, stepUp: token }))).toEqual(
    { version: '1', keys: [KEYS.fund] },
  );
  rejected(
    await send(
      f,
      'save',
      { changes: [{ key: KEYS.fund, text: '另一文案' }], expected_version: '1' },
      { token: fund.token, stepUp: token },
    ),
    10003,
    { tier: 'totp' },
  );
});

it('[AC-F1-02zd#6] 普通后台键无需动态码；同一后台进程改完即见，无缓存；null 覆盖恢复默认', async () => {
  const f = await setup(h);
  expect(success<AdminDict>(await send(f, 'read'))).toEqual({
    version: '0',
    items: expectedItems(),
  });
  for (const [expected, text] of [
    ['0', '最新后台文案'],
    ['1', null],
  ] as const) {
    const saved = success<Saved>(
      await send(f, 'save', { expected_version: expected, changes: [{ key: KEYS.general, text }] }),
    );
    expect(saved).toEqual({ version: expected === '0' ? '1' : '2', keys: [KEYS.general] });
    expect(success<AdminDict>(await send(f, 'read'))).toEqual({
      version: saved.version,
      items: expectedItems(text === null ? {} : { [KEYS.general]: text }),
    });
    expect((await snapshot(h, f.appId)).config[0]!.value).toBe(saved.version);
  }
});

it('[AC-F1-02zd#7] 公共接口冷读、缓存命中及失效后都隔离 admin_dict；版本及普通覆盖保持原行为', async () => {
  const f = await setup(h);
  await seedVersion(h, f.appId, '2');
  await seedItem(h, f, KEYS.general, 2, '后台秘密文案');
  await seedItem(h, f, KEYS.unknown, 2, '不认识的后台文案');
  await seedItem(h, f, KEYS.public, 2, '公开文案');
  const api = await h.startApi();
  const expected = { version: '2', items: { about: { copy_diagnostics: '公开文案' } } };
  expect(await readPublic(api, f.appId)).toEqual(expected);
  expect(await readPublic(api, f.appId)).toEqual(expected);
  expect(success<AdminDict>(await send(f, 'read')).version).toBe(expected.version);
  // Expire the public TTL through its injected clock, never through wall-clock sleeps.
  h.clock.advanceMs(61_000);
  expect(await readPublic(api, f.appId)).toEqual(expected);
});

it('[AC-F1-02zd#8] 编辑列表严格为两份默认并集，键排序、分类、default_text、admin 前缀筛选一致', async () => {
  const f = await setup(h);
  const base = defaults('texts.default.json');
  const admin = defaults('texts.admin.default.json');
  expect(Object.keys(base).filter((key) => Object.hasOwn(admin, key))).toEqual([]);
  const texts = { ...base, ...admin };
  const spec = parseYamlLite(readFileSync(new URL('specs/fund-term-keys.yaml', ROOT), 'utf8')) as {
    fund_terms: { keys: string[]; prefixes: string[] };
    ordinary: { keys: string[]; prefixes: string[] };
  };
  const classOf = (key: string) => {
    const covers = (segment: typeof spec.ordinary) =>
      segment.keys.includes(key) || segment.prefixes.some((prefix) => key.startsWith(prefix));
    return covers(spec.fund_terms) || !covers(spec.ordinary)
      ? 'fund_terms'
      : /^(privacy|perm)\./.test(key)
        ? 'agreement'
        : 'general';
  };
  for (const prefix of ['', 'admin_dict.']) {
    const keys = Object.keys(texts)
      .filter((key) => key.startsWith(prefix))
      .sort();
    const collected: ItemPage['items'] = [];
    for (let page = 1; page <= Math.ceil(keys.length / 200); page++) {
      const data = success<ItemPage>(
        await send(f, 'list', undefined, {
          query: `?page=${page}&page_size=200${prefix === '' ? '' : `&key_prefix=${prefix}`}`,
        }),
      );
      expect(data).toMatchObject({ total: keys.length, dict_version: '0', page, page_size: 200 });
      collected.push(...data.items);
    }
    expect(collected).toEqual(
      keys.map((key) => ({
        key,
        class: classOf(key),
        default_text: texts[key],
        text: null,
        version: null,
      })),
    );
  }
});

it('[AC-F1-02zd#9] 两文件之外的键保存和回滚仍按索引拒绝；admin 已知键能保存和回滚', async () => {
  const f = await setup(h);
  const fund = await member(h, f.appId, ['content.fund_terms']);
  expect(
    success<Saved>(
      await send(f, 'save', {
        expected_version: '0',
        changes: [{ key: KEYS.general, text: '测试覆盖' }],
      }),
    ).version,
  ).toBe('1');
  const before = await snapshot(h, f.appId);
  rejected(
    await send(
      f,
      'save',
      { expected_version: '1', changes: [{ key: KEYS.unknown, text: '未知文案' }] },
      { token: fund.token, stepUp: await stepUp(h, fund) },
    ),
    20001,
    { fields: ['changes[0].key'] },
  );
  rejected(
    await send(
      f,
      'rollback',
      { expected_version: '1', to_version: 0, keys: [KEYS.unknown] },
      { token: fund.token, stepUp: await stepUp(h, fund) },
    ),
    20001,
    { fields: ['keys[0]'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(
    success<Saved>(
      await send(f, 'rollback', { expected_version: '1', to_version: 0, keys: [KEYS.general] }),
    ).version,
  ).toBe('2');
  expect(success<AdminDict>(await send(f, 'read'))).toEqual({
    version: '2',
    items: expectedItems(),
  });
});

it('[AC-F1-02zd#10] admin_report 允许佣金和高佣原文，仍拒绝全网最低；用户键仍拒绝佣金', async () => {
  const f = await setup(h);
  expect(
    success<Saved>(
      await send(f, 'save', {
        expected_version: '0',
        changes: [{ key: KEYS.commission, text: '作废佣金（人工）' }],
      }),
    ).version,
  ).toBe('1');
  const before = await snapshot(h, f.appId);
  rejected(
    await send(f, 'save', {
      expected_version: '1',
      changes: [{ key: KEYS.commission, text: '全网最低' }],
    }),
    20001,
    { fields: ['changes[0].text', '全网最低'] },
  );
  rejected(
    await send(f, 'save', { expected_version: '1', changes: [{ key: KEYS.public, text: '佣金' }] }),
    20001,
    { fields: ['changes[0].text', '佣金'] },
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(success<AdminDict>(await send(f, 'read')).items.risk_action?.void_commission).toBe(
    '作废佣金（人工）',
  );
  const old = await setup(h);
  const fund = await member(h, old.appId, ['content.fund_terms']);
  await seedVersion(h, old.appId, '2', 2);
  await seedItem(h, old, KEYS.high, 1, '高佣历史原文');
  await seedItem(h, old, KEYS.high, 2, '当前文案');
  expect(
    success<Saved>(
      await send(
        old,
        'rollback',
        { expected_version: '2', to_version: 1, keys: [KEYS.high] },
        { token: fund.token, stepUp: await stepUp(h, fund) },
      ),
    ),
  ).toEqual({ version: '3', keys: [KEYS.high] });
  expect(
    success<AdminDict>(await send(old, 'read')).items['withdrawals.auto_decision.failed_conditions']
      ?.warn_high_commission,
  ).toBe('高佣历史原文');
});

it('[AC-F1-02zd#11] 版本和覆盖来自同一快照：版本 SELECT 后提交的新行对本次不可见，对下次可见', async () => {
  const f = await setup(h);
  await seedVersion(h, f.appId, '2');
  await seedItem(h, f, KEYS.general, 1, '快照前');
  let commits = 0;
  h.probe.afterVersion = async () => {
    delete h.probe.afterVersion;
    // Deliberately backfill a historical version using direct fixture SQL. A mere
    // version <= limit filter with two READ COMMITTED reads would expose this row.
    await db.transaction().execute(async (trx) => {
      await trx
        .withSchema('app')
        .insertInto('dict_items')
        .values({
          app_id: f.appId,
          dict: 'admin_dict',
          code: KEYS.second.slice('admin_dict.'.length),
          version: 1,
          text: '并发提交',
          created_by: f.actor.id,
          created_at: h.clock.now(),
        })
        .execute();
      await trx
        .withSchema('app')
        .updateTable('config_items')
        .set({ value: JSON.stringify('3'), version: 2 })
        .where('app_id', '=', f.appId)
        .where('key', '=', 'dict_version')
        .execute();
    });
    commits++;
  };
  try {
    expect(success<AdminDict>(await send(f, 'read'))).toEqual({
      version: '2',
      items: expectedItems({ [KEYS.general]: '快照前' }),
    });
    expect(commits).toBe(1);
    expect(success<AdminDict>(await send(f, 'read'))).toEqual({
      version: '3',
      items: expectedItems({ [KEYS.general]: '快照前', [KEYS.second]: '并发提交' }),
    });
  } finally {
    delete h.probe.afterVersion;
  }
});

it('[AC-F1-02zd#18] 默认文件加载失败时字典读写返回 50001，不以空默认成功，也不留下半次写入', async () => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  const loader = vi.mocked(adminDefaultTexts);
  const original = loader.getMockImplementation()!;
  loader.mockImplementation(() => {
    throw new Error('fixture: invalid admin defaults');
  });
  try {
    rejected(await send(f, 'read'), 50001);
    rejected(await send(f, 'list'), 50001);
    rejected(
      await send(f, 'save', {
        expected_version: '0',
        changes: [{ key: KEYS.public, text: '不应保存' }],
      }),
      50001,
    );
    rejected(
      await send(f, 'rollback', { expected_version: '0', to_version: 0, keys: [KEYS.public] }),
      50001,
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  } finally {
    loader.mockImplementation(original);
  }
});

it('[AC-F1-02zd#19] 快照读取失败返回 50001，不能吞掉数据库故障而返回默认成功', async () => {
  const f = await setup(h);
  h.probe.afterVersion = async () => {
    throw new Error('fixture: database read unavailable');
  };
  try {
    rejected(await send(f, 'read'), 50001);
  } finally {
    delete h.probe.afterVersion;
  }
});
