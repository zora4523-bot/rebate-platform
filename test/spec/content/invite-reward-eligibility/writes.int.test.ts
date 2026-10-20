// HTTP tests run only in the orchestrator's isolated PG/Redis container.
import { expect, it } from 'vitest';
import {
  auditsSince,
  batch,
  call,
  current,
  denied,
  expectAudit,
  member,
  needsTotp,
  putRow,
  putVersion,
  rejected,
  rollback,
  snapshot,
  stepUp,
  success,
  update,
  versionsOf,
  type Item,
} from '../config-items/kit.ts';
import { checkSuccess, prepare } from '../invite-reward-config/kit.ts';
import { noCampaignLock, registered, setup, useHarness } from './kit.ts';
import { AMOUNT, DAILY, ENABLED, KEY, TOTAL } from './oracle.ts';

const h = useHarness();

it('[AC-F1-02zx#7] config.business 加 step-up 首次 PUT 45，版本 1、历史与审计各一条', async () => {
  const f = await setup(h);
  await registered(f);
  const { who, token } = await member(h, f, ['config.business']);
  const caller = { ...f, actor: who, token };
  const extra = { stepUp: await stepUp(caller) };
  const before = await snapshot(h, f.appId);
  const start = f.queries.length;
  const item = await success<Item>(
    await update(
      caller,
      KEY,
      {
        value: 45,
        expected_version: 0,
      },
      extra,
    ),
    'update',
  );
  expect(item).toMatchObject({ key: KEY, value: 45, version: 1, permission: 'config.business' });
  expect(await current(h, f.appId, KEY)).toMatchObject({
    value: 45,
    version: 1,
    updated_by: who.username,
  });
  const history = await versionsOf(h, f.appId, KEY);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ value: 45, version: 1, updated_by_admin_id: who.id });
  const audits = await auditsSince(h, f.appId, before);
  expect(audits).toHaveLength(1);
  expectAudit(audits[0]!, f, who, 'config_item_change', {
    key: KEY,
    from: 0,
    to: 1,
    before: null,
    after: 45,
  });
  expect(f.queries.slice(start).some((query) => query.includes('config_items'))).toBe(true);
  noCampaignLock(f, start);
});

it.each([0, 3651, 30.5])(
  '[AC-F1-02zx#8] PUT %s 返回 20001 [value]，当前值、历史和审计不变',
  async (value) => {
    const f = await setup(h);
    await putRow(h, f.appId, KEY, 30);
    await registered(f, 30, 1);
    const extra = { stepUp: await stepUp(f) };
    const before = await snapshot(h, f.appId);
    await rejected(await update(f, KEY, { value, expected_version: 1 }, extra), 'update', 20001, {
      fields: ['value'],
    });
    expect(await snapshot(h, f.appId)).toStrictEqual(before);
  },
);

it('[AC-F1-02zx#9] batch 混合合法金额与 3651 天，报资格键名且整批不写', async () => {
  const f = await setup(h);
  await registered(f);
  await putRow(h, f.appId, AMOUNT, 1000);
  const extra = { stepUp: await stepUp(f) };
  const before = await snapshot(h, f.appId);
  await rejected(
    await batch(
      f,
      {
        items: [
          { key: AMOUNT, value: 1100, expected_version: 1 },
          { key: KEY, value: 3651, expected_version: 0 },
        ],
      },
      extra,
    ),
    'batch',
    20001,
    { fields: [KEY] },
  );
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it('[AC-F1-02zx#10] rollback 到 SQL 注入的 0 天历史被拒，报 to_version 且不写', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, KEY, 45, 2);
  await putVersion(h, f.appId, KEY, 1, 0, f.actor);
  await registered(f, 45, 2);
  const extra = { stepUp: await stepUp(f) };
  const before = await snapshot(h, f.appId);
  await rejected(
    await rollback(f, KEY, { to_version: 1, expected_version: 2 }, extra),
    'rollback',
    20001,
    { fields: ['to_version'] },
  );
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

const wrongPermissions = (['config.risk', 'config.general'] as const).flatMap((permission) =>
  (['update', 'batch', 'rollback'] as const).map((operation) => ({ permission, operation })),
);
it.each(wrongPermissions)(
  '[AC-F1-02zx#11] 仅 $permission 即使带 step-up 也不能 $operation 资格天数',
  async ({ permission, operation }) => {
    const f = await setup(h);
    await putRow(h, f.appId, KEY, 45, 2);
    await putVersion(h, f.appId, KEY, 1, 30, f.actor);
    await registered(f, 45, 2);
    const { who, token } = await member(h, f, [permission]);
    const caller = { ...f, actor: who, token };
    const proof = await stepUp(caller);
    const before = await snapshot(h, f.appId);
    const body =
      operation === 'batch'
        ? { items: [{ key: KEY, value: 60, expected_version: 2 }] }
        : operation === 'rollback'
          ? { to_version: 1, expected_version: 2 }
          : { value: 60, expected_version: 2 };
    await denied(await call(caller, operation, { key: KEY, body, stepUp: proof }), operation);
    expect(await snapshot(h, f.appId)).toStrictEqual(before);
  },
);

it('[AC-F1-02zx#12] config.business 未 step-up 修改天数和同组金额均要求 TOTP', async () => {
  const f = await setup(h);
  await registered(f);
  const { who, token } = await member(h, f, ['config.business']);
  const caller = { ...f, actor: who, token };
  const before = await snapshot(h, f.appId);
  for (const key of [KEY, AMOUNT]) {
    await needsTotp(await update(caller, key, { value: 45, expected_version: 0 }), 'update');
  }
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it('[AC-F1-02zx#13] 已开启且金额预算为正时 PUT 1 天成功，不获取活动咨询锁', async () => {
  const f = await setup(h);
  for (const key of [AMOUNT, DAILY, TOTAL]) await putRow(h, f.appId, key, 100);
  await putRow(h, f.appId, ENABLED, true);
  await registered(f);
  const extra = { stepUp: await stepUp(f) };
  const start = f.queries.length;
  await success(await update(f, KEY, { value: 1, expected_version: 0 }, extra), 'update');
  expect(await current(h, f.appId, KEY)).toMatchObject({ value: 1, version: 1 });
  expect(await current(h, f.appId, ENABLED)).toMatchObject({ value: true, version: 1 });
  noCampaignLock(f, start);
});

it('[AC-F1-02zx#14] 登记后缺资格天数行也能开启活动，不隐式写入默认值', async () => {
  const f = await setup(h);
  await registered(f);
  for (const key of [AMOUNT, DAILY, TOTAL]) await putRow(h, f.appId, key, 100);
  expect(await current(h, f.appId, KEY)).toBeUndefined();
  const request = await prepare(f, 'switch', ENABLED, {
    value: true,
    expected_version: 0,
  });
  await checkSuccess(await request(), 'switch');
  expect(await current(h, f.appId, ENABLED)).toMatchObject({ value: true, version: 1 });
  expect(await current(h, f.appId, KEY)).toBeUndefined();
  expect(await versionsOf(h, f.appId, KEY)).toStrictEqual([]);
});

it.each(['batch', 'rollback'] as const)(
  '[AC-F1-02zx#15] config.business 加 step-up 的合法 %s 成功且不获取活动咨询锁',
  async (operation) => {
    const f = await setup(h);
    await putRow(h, f.appId, KEY, 45, 2);
    await putVersion(h, f.appId, KEY, 1, 30, f.actor);
    await registered(f, 45, 2);
    const { who, token } = await member(h, f, ['config.business']);
    const caller = { ...f, actor: who, token };
    const proof = await stepUp(caller);
    const before = await snapshot(h, f.appId);
    const start = f.queries.length;
    const body =
      operation === 'batch'
        ? { items: [{ key: KEY, value: 30, expected_version: 2 }] }
        : { to_version: 1, expected_version: 2 };
    await success(await call(caller, operation, { key: KEY, body, stepUp: proof }), operation);
    expect(await current(h, f.appId, KEY)).toMatchObject({ value: 30, version: 3 });
    const after = await snapshot(h, f.appId);
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    noCampaignLock(f, start);
  },
);
