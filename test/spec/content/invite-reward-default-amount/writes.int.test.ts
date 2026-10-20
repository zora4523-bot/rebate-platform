import { expect, it } from 'vitest';
import { alertLines } from '../kill-switches/kit.ts';
import {
  AMOUNT,
  DAILY,
  ENABLED,
  TOTAL,
  budgets,
  checkSuccess,
  current,
  enable,
  prepare,
  putRow,
  setup,
  snapshot,
  unchanged,
  useHarness,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-02zza#3] 金额无行可打开，只增加开关的行、历史、审计和告警', async () => {
  const f = await setup(h);
  await budgets(h, f);
  const open = await prepare(f, 'switch', ENABLED, { value: true, expected_version: 0 });
  const before = await snapshot(h, f.appId);
  const logStart = f.lines.length;
  const response = await open();
  await checkSuccess(response, 'switch');
  expect(response.json().data).toMatchObject({ key: ENABLED, value: true, version: 1 });
  expect(await current(h, f.appId, ENABLED)).toMatchObject({ value: true, version: 1 });
  expect(await current(h, f.appId, AMOUNT)).toBeUndefined();
  const after = await snapshot(h, f.appId);
  expect(after.items.filter((row) => row.key !== ENABLED)).toStrictEqual(before.items);
  expect(after.versions).toHaveLength(before.versions.length + 1);
  expect(after.versions.filter((row) => row.key === AMOUNT)).toStrictEqual([]);
  expect(after.versions.filter((row) => row.key === ENABLED)).toMatchObject([
    { app_id: f.appId, key: ENABLED, value: true, version: 1 },
  ]);
  const audits = after.audits.filter((row) => !before.audits.some((old) => old.id === row.id));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    app_id: f.appId,
    admin_id: f.actor.id,
    action: 'kill_switch_change',
    target: ENABLED,
  });
  const alerts = alertLines(f.lines, logStart);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ key: ENABLED, app_id: f.appId, to_value: true });
});

it.each([
  { key: DAILY, value: undefined },
  { key: TOTAL, value: undefined },
  { key: DAILY, value: 0 },
  { key: TOTAL, value: 0 },
])(
  '[AC-F1-02zza#4] 金额无行时预算 $key=$value 拒绝无副作用，补足预算后才能打开',
  async ({ key, value }) => {
    const f = await setup(h);
    await putRow(h, f.appId, key === DAILY ? TOTAL : DAILY, 100);
    if (value !== undefined) await putRow(h, f.appId, key, value);
    await unchanged(
      h,
      f,
      await prepare(f, 'switch', ENABLED, { value: true, expected_version: 0 }),
      'switch',
      ['value'],
    );
    const fill = await prepare(f, 'update', key, {
      value: 100,
      expected_version: value === undefined ? 0 : 1,
    });
    await checkSuccess(await fill(), 'update');
    await enable(f);
    expect(await current(h, f.appId, AMOUNT)).toBeUndefined();
    expect(await current(h, f.appId, ENABLED)).toMatchObject({ value: true, version: 1 });
  },
);

it('[AC-F1-02zza#5] 缺行金额可打开，但已有非法金额不能被默认值掩盖', async () => {
  // One absence-versus-presence matrix: the old implementation fails on the missing-row case.
  for (const amount of [undefined, 0, -1, null, '100', true, false, 1.5, [], {}]) {
    const f = await setup(h);
    await budgets(h, f);
    if (amount !== undefined) await putRow(h, f.appId, AMOUNT, amount);
    const open = await prepare(f, 'switch', ENABLED, { value: true, expected_version: 0 });
    if (amount === undefined) {
      await checkSuccess(await open(), 'switch');
      expect(await current(h, f.appId, AMOUNT)).toBeUndefined();
    } else {
      await unchanged(h, f, open, 'switch', ['value']);
      expect(await current(h, f.appId, AMOUNT)).toMatchObject({ value: amount, version: 1 });
    }
  }
}, 30_000);

it('[AC-F1-02zza#6] 以默认金额打开后首写 0 拒绝，首写 500 成功，关闭后才能改 0', async () => {
  const f = await setup(h);
  await budgets(h, f);
  await enable(f);
  expect(await current(h, f.appId, AMOUNT)).toBeUndefined();
  await unchanged(
    h,
    f,
    await prepare(f, 'update', AMOUNT, { value: 0, expected_version: 0 }),
    'update',
    ['value'],
  );
  const positive = await prepare(f, 'update', AMOUNT, { value: 500, expected_version: 0 });
  await checkSuccess(await positive(), 'update');
  expect(await current(h, f.appId, AMOUNT)).toMatchObject({ value: 500, version: 1 });
  const off = await prepare(f, 'switch', ENABLED, { value: false, expected_version: 1 });
  await checkSuccess(await off(), 'switch');
  const zero = await prepare(f, 'update', AMOUNT, { value: 0, expected_version: 1 });
  await checkSuccess(await zero(), 'update');
  expect(await current(h, f.appId, AMOUNT)).toMatchObject({ value: 0, version: 2 });
  expect(await current(h, f.appId, ENABLED)).toMatchObject({ value: false, version: 2 });
});

it('[AC-F1-02zza#7] app 隔离：别处的 0 不挡缺行默认，本 app 缺行也不掩盖别处的 0', async () => {
  const missing = await setup(h);
  const zero = await setup(h);
  await budgets(h, missing);
  await budgets(h, zero);
  await putRow(h, zero.appId, AMOUNT, 0);
  const beforeOther = await snapshot(h, zero.appId);
  await enable(missing);
  expect(await snapshot(h, zero.appId)).toStrictEqual(beforeOther);
  const beforeMissing = await snapshot(h, missing.appId);
  await unchanged(
    h,
    zero,
    await prepare(zero, 'switch', ENABLED, { value: true, expected_version: 0 }),
    'switch',
    ['value'],
  );
  expect(await snapshot(h, missing.appId)).toStrictEqual(beforeMissing);
  expect(await current(h, missing.appId, AMOUNT)).toBeUndefined();
  expect(await current(h, missing.appId, ENABLED)).toMatchObject({ value: true, version: 1 });
  expect(await current(h, zero.appId, AMOUNT)).toMatchObject({ value: 0, version: 1 });
  expect(await current(h, zero.appId, ENABLED)).toBeUndefined();
});
