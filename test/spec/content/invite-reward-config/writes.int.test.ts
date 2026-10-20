import { expect, it } from 'vitest';
import { member } from '../config-items/kit.ts';
import { ACTION, alertLines, expectAuditFacts, listAll } from '../kill-switches/kit.ts';
import {
  checkRejected,
  checkSuccess,
  current,
  enable,
  getItem,
  positive,
  prepare,
  putRow,
  putVersion,
  setup,
  snapshot,
  unchanged,
  useHarness,
} from './kit.ts';
import {
  AMOUNT,
  CONFIGS,
  DAILY,
  ENABLED,
  MIN_PAID,
  PAUSED,
  POSITIVE_WHEN_ENABLED,
  TOTAL,
  WINDOW,
} from './oracle.ts';

const h = useHarness();

it('[AC-F1-02zn#7] 缺行开关列出默认 off；缺预算、仅 daily 和完整预算依次校验', async () => {
  const f = await setup(h);
  const listed = await listAll(f, f.token);
  for (const key of [ENABLED, PAUSED]) {
    expect(listed.find((row) => row.key === key)).toMatchObject({
      default: false,
      value: null,
      version: 0,
    });
  }
  await putRow(h, f.appId, AMOUNT, 1000);
  await unchanged(
    h,
    f,
    await prepare(f, 'switch', ENABLED, { value: true, expected_version: 0 }),
    'switch',
    ['value'],
  );
  await putRow(h, f.appId, DAILY, 100);
  await unchanged(
    h,
    f,
    await prepare(f, 'switch', ENABLED, { value: true, expected_version: 0 }),
    'switch',
    ['value'],
  );
  await putRow(h, f.appId, TOTAL, 100);
  await enable(f);
  expect(await current(h, f.appId, ENABLED)).toMatchObject({ value: true, version: 1 });
});

// F1-02zzb (test-change, transitional; F1-02zt tightens): the missing amount row is split out
// below; every other case keeps its original expectation.
const invalidPrerequisites = POSITIVE_WHEN_ENABLED.flatMap((key) =>
  [undefined, 0, -1, 1.5, '100', null, true].map((value) => ({ key, value })),
).filter(({ key, value }) => !(key === AMOUNT && value === undefined));
it.each(invalidPrerequisites)(
  '[AC-F1-02zn#8] 开启时 $key=$value（含缺行）拒绝且无任何写入/告警',
  async ({ key, value }) => {
    const f = await setup(h);
    await positive(h, f, key);
    if (value !== undefined) await putRow(h, f.appId, key, value);
    await unchanged(
      h,
      f,
      await prepare(f, 'switch', ENABLED, { value: true, expected_version: 0 }),
      'switch',
      ['value'],
    );
  },
);

// F1-02zzb (test-change, transitional; F1-02zt tightens): 04 §10.1 reads a missing amount as the
// BR-INV-24 default (08: 1000 per side). Until F1-02zza lands either reading is accepted, chosen
// by this response's status; both branches are strict. F1-02zt keeps only the 200 branch.
it('[AC-F1-02zn#8] 开启时 amount_fen 缺行：拒绝且无写入（缺行按 0），或开启成功且不补写金额行（缺行按 08 默认 1000）', async () => {
  const f = await setup(h);
  await positive(h, f, AMOUNT);
  const request = await prepare(f, 'switch', ENABLED, { value: true, expected_version: 0 });
  const before = await snapshot(h, f.appId);
  const logStart = f.lines.length;
  const response = await request();
  const after = await snapshot(h, f.appId);
  const alerts = alertLines(f.lines, logStart);
  if (response.statusCode === 400) {
    await checkRejected(response, 'switch', ['value']);
    expect(after).toStrictEqual(before);
    expect(alerts).toStrictEqual([]);
    return;
  }
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  await checkSuccess(response, 'switch');
  expect(await current(h, f.appId, ENABLED)).toMatchObject({ value: true, version: 1 });
  expect(await current(h, f.appId, AMOUNT)).toBeUndefined();
  expect(after.items.filter((row) => row.key !== ENABLED)).toStrictEqual(before.items);
  expect(after.items.filter((row) => row.key === ENABLED)).toHaveLength(1);
  expect(after.versions.filter((row) => row.key === AMOUNT)).toStrictEqual([]);
  expect(after.versions.filter((row) => row.key !== ENABLED)).toStrictEqual(before.versions);
  expect(
    after.versions.filter((row) => row.key === ENABLED).map((row) => [row.version, row.value]),
  ).toStrictEqual([[1, true]]);
  expect(after.versions).toHaveLength(before.versions.length + 1);
  expect(after.audits.slice(0, before.audits.length)).toStrictEqual(before.audits);
  expect(after.audits).toHaveLength(before.audits.length + 1);
  expect(after.audits[before.audits.length]).toMatchObject({
    app_id: f.appId,
    admin_id: f.actor.id,
    action: ACTION,
  });
  expectAuditFacts(after.audits[before.audits.length]!, {
    key: ENABLED,
    from: 0,
    to: 1,
    after: true,
    reason: null,
  });
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ key: ENABLED });
});

const guardedWrites = POSITIVE_WHEN_ENABLED.flatMap((key) =>
  (['update', 'batch', 'rollback'] as const).map((operation) => ({ key, operation })),
);
it.each(guardedWrites)(
  '[AC-F1-02zn#9] on 时 $operation 将 $key 写零：20001，整笔回滚且无告警',
  async ({ key, operation }) => {
    const f = await setup(h);
    await positive(h, f, key);
    await putRow(h, f.appId, key, 100, 2);
    await putVersion(h, f.appId, key, 1, 0, f.actor);
    await enable(f);
    // amount sorts before both budgets: a late failure must undo that earlier write too.
    const body =
      operation === 'batch'
        ? {
            items: [
              { key: 'withdraw.payout_account_verify_per_day', value: 4, expected_version: 0 },
              { key: AMOUNT, value: 101, expected_version: key === AMOUNT ? 2 : 1 },
              ...(key === AMOUNT ? [] : [{ key, value: 0, expected_version: 2 }]),
            ].map((entry) => (entry.key === key ? { ...entry, value: 0 } : entry)),
          }
        : operation === 'rollback'
          ? { to_version: 1, expected_version: 2 }
          : { value: 0, expected_version: 2 };
    const fields =
      operation === 'batch' ? [key] : operation === 'rollback' ? ['to_version'] : ['value'];
    await unchanged(h, f, await prepare(f, operation, key, body), operation, fields);
  },
);

it.each(guardedWrites)(
  '[AC-F1-02zn#10] off 时 $operation 允许 $key 为零',
  async ({ key, operation }) => {
    const f = await setup(h);
    await putRow(h, f.appId, key, 100, 2);
    await putVersion(h, f.appId, key, 1, 0, f.actor);
    const body =
      operation === 'batch'
        ? { items: [{ key, value: 0, expected_version: 2 }] }
        : operation === 'rollback'
          ? { to_version: 1, expected_version: 2 }
          : { value: 0, expected_version: 2 };
    const request = await prepare(f, operation, key, body);
    await checkSuccess(await request(), operation);
    expect(await current(h, f.appId, key)).toMatchObject({ value: 0, version: 3 });
  },
);

it('[AC-F1-02zn#11] 关闭开关后预算和金额可置零；首单下限不参与正数门槛', async () => {
  const f = await setup(h);
  await positive(h, f);
  await putRow(h, f.appId, MIN_PAID, 0);
  await enable(f);
  const off = await prepare(f, 'switch', ENABLED, { value: false, expected_version: 1 });
  await checkSuccess(await off(), 'switch');
  for (const key of POSITIVE_WHEN_ENABLED) {
    const request = await prepare(f, 'update', key, { value: 0, expected_version: 1 });
    await checkSuccess(await request(), 'update');
    expect(await current(h, f.appId, key)).toMatchObject({ value: 0, version: 2 });
  }
});

it('[AC-F1-02zn#12] 金额与预算缺行时仍能关闭 enabled、打开及关闭 payout_paused', async () => {
  const f = await setup(h);
  await putRow(h, f.appId, ENABLED, true);
  for (const [key, value, version] of [
    [ENABLED, false, 1],
    [PAUSED, true, 0],
    [PAUSED, false, 1],
  ] as const) {
    const request = await prepare(f, 'switch', key, { value, expected_version: version });
    await checkSuccess(await request(), 'switch');
    expect(await current(h, f.appId, key)).toMatchObject({ value, version: version + 1 });
  }
});

it('[AC-F1-02zn#13] on 时允许 1 分门槛与正数改值，min_paid=0、ip_window=1 不被误挡', async () => {
  const f = await setup(h);
  for (const key of POSITIVE_WHEN_ENABLED) await putRow(h, f.appId, key, 1);
  await enable(f);
  for (const [key, value, version] of [
    [AMOUNT, 2, 1],
    [DAILY, 2, 1],
    [TOTAL, 2, 1],
    [MIN_PAID, 0, 0],
    [WINDOW, 1, 0],
  ] as const) {
    const request = await prepare(f, 'update', key, { value, expected_version: version });
    await checkSuccess(await request(), 'update');
    expect(await current(h, f.appId, key)).toMatchObject({ value, version: version + 1 });
  }
});

it('[AC-F1-02zn#14] app_id 隔离：别的 app 的非零预算不能助开，别的 app 开启不能阻止本 app 写零', async () => {
  const f = await setup(h);
  const other = await setup(h);
  await positive(h, other);
  await enable(other);
  await putRow(h, f.appId, AMOUNT, 100);
  await unchanged(
    h,
    f,
    await prepare(f, 'switch', ENABLED, { value: true, expected_version: 0 }),
    'switch',
    ['value'],
  );
  const request = await prepare(f, 'update', TOTAL, { value: 0, expected_version: 0 });
  await checkSuccess(await request(), 'update');
  expect(await current(h, other.appId, TOTAL)).toMatchObject({ value: 100, version: 1 });
  expect(await current(h, other.appId, ENABLED)).toMatchObject({ value: true, version: 1 });
});

it('[AC-F1-02zn#15] 普通管理员凭对应 config 权限和 switch.all 加 step-up 可写', async () => {
  const f = await setup(h);
  for (const row of CONFIGS) {
    const caller = await member(h, f, [row.permission]);
    const request = await prepare(
      { ...f, actor: caller.who, token: caller.token },
      'update',
      row.key,
      {
        value: row.key === WINDOW ? 24 : 100,
        expected_version: 0,
      },
    );
    await checkSuccess(await request(), 'update');
  }
  const caller = await member(h, f, ['switch.all']);
  const request = await prepare(
    { ...f, actor: caller.who, token: caller.token },
    'switch',
    ENABLED,
    {
      value: true,
      expected_version: 0,
    },
  );
  await checkSuccess(await request(), 'switch');
  expect(await current(h, f.appId, ENABLED)).toMatchObject({ value: true });
});

const rangeWrites = CONFIGS.flatMap((row) =>
  (['update', 'batch', 'rollback'] as const).map((operation) => ({ ...row, operation })),
);
it.each(rangeWrites)(
  '[AC-F1-02zn#16] $operation 对 $key 拒绝越界历史/输入，错误字段符合契约',
  async ({ key, min, seed: defaultValue, operation }) => {
    const f = await setup(h);
    await putRow(h, f.appId, key, defaultValue, 2);
    await putVersion(h, f.appId, key, 1, min - 1, f.actor);
    // Establish the registered HTTP resource: unknown-key batch errors cannot give false green.
    expect(await getItem(f, key)).toMatchObject({ value: defaultValue, version: 2 });
    const body =
      operation === 'batch'
        ? { items: [{ key, value: min - 1, expected_version: 2 }] }
        : operation === 'rollback'
          ? { to_version: 1, expected_version: 2 }
          : { value: min - 1, expected_version: 2 };
    const fields =
      operation === 'batch' ? [key] : operation === 'rollback' ? ['to_version'] : ['value'];
    await unchanged(h, f, await prepare(f, operation, key, body), operation, fields);
  },
);
