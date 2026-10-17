// F1-10e ruling 16 and adminUpdateConfigItem: PUT /admin/v1/config-items/{key} — key and value
// checks, CAS on expected_version (first write 0), history version, audit, alert, same-value
// no-op, one transaction.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seed } from '../../admin/accounts/kit.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  FUND_FLAGS,
  KEYS,
  ROW_AT,
  UNREGISTERED,
  alertsSince,
  appWith,
  auditsSince,
  conflict,
  current,
  expectAlerted,
  expectAudit,
  expectedOf,
  historyPage,
  itemOf,
  keyInvalid,
  normalized,
  normalizedVersion,
  putRow,
  rejected,
  setup,
  snapshot,
  stepUp,
  success,
  update,
  valueInvalid,
  versionsOf,
  written,
  type Item,
  type Setup,
} from './kit.ts';

const h = useHarness();
/** A totp token when the key's point needs one. */
const tokenFor = async (f: Setup, key: string) =>
  expectedOf(key).permission === 'config.general' ? {} : { stepUp: await stepUp(f) };

it.each([
  [KEYS.general, 3],
  [KEYS.generalFlag, false],
  ['union.taobao.auth_methods.ios', ['web_code']],
  [KEYS.risk, 900],
  [KEYS.business, 5],
] as const)(
  '[AC-F1-10e#26] 首次写入 %s（无行，expected_version=0）：version 1，当前行、历史行、审计、告警各一，时间取注入时钟',
  async (key, value) => {
    const f = await setup(h);
    const extra = await tokenFor(f, key);
    const before = await snapshot(h, f.appId);
    const seen = f.lines.length;
    const item = await success<Item>(
      await update(f, key, { value, expected_version: 0, reason: '首次填写' }, extra),
      'update',
    );
    const now = f.clock.now().toISOString();
    expect(normalized(item)).toStrictEqual(
      itemOf(key, { value, version: 1, updated_by: f.actor.username, updated_at: now }),
    );
    const row = await current(h, f.appId, key);
    expect(row).toMatchObject({ value, version: 1, updated_by: f.actor.username });
    expect(row!.updated_at.toISOString()).toBe(now);
    const history = await versionsOf(h, f.appId, key);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      version: 1,
      value,
      updated_by: f.actor.username,
      updated_by_admin_id: f.actor.id,
      reason: '首次填写',
    });
    expect(history[0]!.created_at.toISOString()).toBe(now);
    const audits = await auditsSince(h, f.appId, before);
    expect(audits).toHaveLength(1);
    expectAudit(audits[0]!, f, f.actor, 'config_item_change', {
      key,
      from: 0,
      to: 1,
      before: null,
      after: value,
      reason: '首次填写',
    });
    expectAlerted(f.lines, seen, [key]);
    expect(alertsSince(f.lines, seen)).toHaveLength(1);
    const page = await historyPage(f, key);
    expect(page.items.map(normalizedVersion)).toStrictEqual([
      { version: 1, value, updated_by: f.actor.username, reason: '首次填写', created_at: now },
    ]);
  },
);

it('[AC-F1-10e#27] 改已有值：version+1，新历史行理由为 null，旧历史不动，审计带前后值与版本', async () => {
  const f = await setup(h);
  await written(h, f.appId, KEYS.general, [3, 6], f.actor);
  const oldHistory = await versionsOf(h, f.appId, KEYS.general);
  const before = await snapshot(h, f.appId);
  const seen = f.lines.length;
  const item = await success<Item>(
    await update(f, KEYS.general, { value: 9, expected_version: 2 }),
    'update',
  );
  expect(item).toMatchObject({ value: 9, version: 3, updated_by: f.actor.username });
  const history = await versionsOf(h, f.appId, KEYS.general);
  expect(history.slice(0, 2)).toStrictEqual(oldHistory);
  expect(history[2]).toMatchObject({ version: 3, value: 9, reason: null });
  const audits = await auditsSince(h, f.appId, before);
  expect(audits).toHaveLength(1);
  expectAudit(audits[0]!, f, f.actor, 'config_item_change', {
    key: KEYS.general,
    from: 2,
    to: 3,
    before: 6,
    after: 9,
  });
  expectAlerted(f.lines, seen, [KEYS.general]);
});

it('[AC-F1-10e#28] 种子行（version 1、无历史行）照常改：version 2，历史只有新写的 2', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEYS.riskFlag, true);
  const item = await success<Item>(
    await update(
      f,
      KEYS.riskFlag,
      { value: false, expected_version: 1 },
      { stepUp: await stepUp(f) },
    ),
    'update',
  );
  expect(item).toMatchObject({ value: false, version: 2 });
  expect((await versionsOf(h, f.appId, KEYS.riskFlag)).map((v) => v.version)).toStrictEqual([2]);
  const page = await historyPage(f, KEYS.riskFlag);
  expect(page.total).toBe(1);
  expect(page.items.map((v) => [v.version, v.value])).toStrictEqual([[2, false]]);
});

it('[AC-F1-10e#29] CAS：expected_version 与当前不符 20902 resource=config_item，不写库不告警', async () => {
  const f = await setup(h);
  await written(h, f.appId, KEYS.general, [3, 6], f.actor);
  const before = await snapshot(h, f.appId);
  const seen = f.lines.length;
  for (const expected of [0, 1, 3, 100]) {
    await conflict(
      await update(f, KEYS.general, { value: 9, expected_version: expected }),
      'update',
    );
  }
  // Never written: only 0 matches.
  for (const expected of [1, 2]) {
    await conflict(
      await update(f, KEYS.generalFlag, { value: false, expected_version: expected }),
      'update',
    );
  }
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
  expect(alertsSince(f.lines, seen)).toStrictEqual([]);
});

it('[AC-F1-10e#30] 同值写入且版本匹配：200 返回当前项，不加 version、不写历史 / 审计、不告警；版本不符仍 20902', async () => {
  const f = await setup(h);
  await written(h, f.appId, KEYS.general, [3, 6], f.actor);
  await putRow(h, f.appId, 'union.taobao.auth_methods.ios', ['web_code']);
  const before = await snapshot(h, f.appId);
  const seen = f.lines.length;
  const item = await success<Item>(
    await update(f, KEYS.general, { value: 6, expected_version: 2, reason: '无变化' }),
    'update',
  );
  expect(normalized(item)).toStrictEqual(
    itemOf(KEYS.general, {
      value: 6,
      version: 2,
      updated_by: 'history-snapshot',
      updated_at: ROW_AT,
    }),
  );
  const same = await success<Item>(
    await update(f, 'union.taobao.auth_methods.ios', { value: ['web_code'], expected_version: 1 }),
    'update',
  );
  expect(same).toMatchObject({ value: ['web_code'], version: 1 });
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
  expect(alertsSince(f.lines, seen)).toStrictEqual([]);
  await conflict(await update(f, KEYS.general, { value: 6, expected_version: 1 }), 'update');
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it.each(UNREGISTERED)('[AC-F1-10e#31] 注册表外的键 %s 改值 20001 [key]，不写库', async (key) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  await keyInvalid(
    await update(f, key, { value: true, expected_version: 0 }, { stepUp: await stepUp(f) }),
    'update',
  );
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it.each([...FUND_FLAGS, 'agent.page_guide.routes', 'external_hosts'])(
  '[AC-F1-10e#32] 不可改的键 %s：值合型、版本匹配也 20001 [key]，不写库',
  async (key) => {
    const f = await setup(h);
    const value = expectedOf(key).valueType === 'boolean' ? true : ['Wallet'];
    await putRow(h, f.appId, key, expectedOf(key).valueType === 'boolean' ? false : []);
    const before = await snapshot(h, f.appId);
    const extra = await tokenFor(f, key);
    await keyInvalid(await update(f, key, { value, expected_version: 1 }, extra), 'update');
    await keyInvalid(await update(f, key, { value, expected_version: 0 }, extra), 'update');
    expect(await snapshot(h, f.appId)).toStrictEqual(before);
  },
);

it.each([
  [KEYS.general, '3'],
  [KEYS.general, true],
  [KEYS.general, null],
  [KEYS.general, [3]],
  [KEYS.general, { value: 3 }],
  [KEYS.generalFlag, 'true'],
  [KEYS.generalFlag, 1],
  [KEYS.generalFlag, null],
  ['union.taobao.auth_methods.ios', 'web_code'],
  ['union.taobao.auth_methods.ios', 1],
  ['union.taobao.auth_methods.ios', null],
  [KEYS.risk, '600'],
  [KEYS.business, false],
] as const)(
  '[AC-F1-10e#33] 值不合 %s 的登记类型（%j）20001 [value]；先校验后比版本：版本也不符时仍是 20001 [value]',
  async (key, value) => {
    const f = await setup(h);
    await putRow(h, f.appId, key, expectedOf(key).valueType === 'object' ? ['web_code'] : 1, 1);
    const before = await snapshot(h, f.appId);
    for (const expected of [1, 7]) {
      await valueInvalid(
        await update(f, key, { value, expected_version: expected }, await tokenFor(f, key)),
        'update',
      );
    }
    expect(await snapshot(h, f.appId)).toStrictEqual(before);
  },
);

it.each([
  { value: 3 },
  { expected_version: 0 },
  { value: 3, expected_version: -1 },
  { value: 3, expected_version: '0' },
  { value: 3, expected_version: 0, reason: 'x'.repeat(201) },
  { value: 3, expected_version: 0, reason: '' },
  { value: 3, expected_version: 0, app_id: 'other' },
  { value: 3, expected_version: 0, updated_by: 'someone-else' },
])('[AC-F1-10e#34] 请求体不合契约 %j 20001，不写库', async (body) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  await rejected(await update(f, KEYS.general, body), 'update', 20001);
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it.each([
  ['audit_logs', false],
  ['audit_logs', true],
  ['config_item_versions', false],
  ['config_item_versions', true],
] as const)(
  '[AC-F1-10e#35] 同一事务：写 %s 失败（已有行=%s）时当前值、历史、审计全不落，不告警；重试照常成功',
  async (table, existing) => {
    const f = await setup(h);
    if (existing) await written(h, f.appId, KEYS.general, [3], f.actor);
    const expected = existing ? 1 : 0;
    const before = await snapshot(h, f.appId);
    let reached = false;
    const db = h.db.withPlugin({
      transformQuery(args) {
        if (
          args.node.kind === 'InsertQueryNode' &&
          new RegExp(`\\b${table}\\b`).test(JSON.stringify(args.node.into))
        ) {
          reached = true;
          throw new Error(`injected ${table} failure`);
        }
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const app = await appWith(h, f, db);
    const seen = f.lines.length;
    await rejected(
      await update({ ...f, app }, KEYS.general, { value: 8, expected_version: expected }),
      'update',
      50001,
    );
    expect(reached).toBe(true);
    expect(await snapshot(h, f.appId)).toStrictEqual(before);
    expect(alertsSince(f.lines, seen)).toStrictEqual([]);
    const item = await success<Item>(
      await update(f, KEYS.general, { value: 8, expected_version: expected }),
      'update',
    );
    expect(item).toMatchObject({ value: 8, version: expected + 1 });
  },
);

it('[AC-F1-10e#36] 写按令牌的 app 隔离：别的 app 同键同版本的行、历史与审计不动', async () => {
  const f = await setup(h);
  const otherApp = `f1-10e-other-${randomUUID()}`;
  const other = await seed(h, otherApp, { isSuper: true });
  await written(h, otherApp, KEYS.general, [7, 8], other);
  const foreign = await snapshot(h, otherApp);
  // My app has nothing yet: the other app's version 2 is not mine.
  await conflict(await update(f, KEYS.general, { value: 1, expected_version: 2 }), 'update');
  await success(await update(f, KEYS.general, { value: 1, expected_version: 0 }), 'update');
  await written(h, f.appId, KEYS.generalFlag, [true, false], f.actor);
  await written(h, otherApp, KEYS.generalFlag, [true, false], other);
  const foreign2 = await snapshot(h, otherApp);
  expect(foreign2.items.filter((r) => r.key === KEYS.general)).toStrictEqual(
    foreign.items.filter((r) => r.key === KEYS.general),
  );
  await success(await update(f, KEYS.generalFlag, { value: true, expected_version: 2 }), 'update');
  expect(await snapshot(h, otherApp)).toStrictEqual(foreign2);
  expect(await current(h, f.appId, KEYS.generalFlag)).toMatchObject({ value: true, version: 3 });
});
