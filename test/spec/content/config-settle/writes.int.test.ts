// Admin-entry integration tests. Run only in the orchestrator's isolated PG/Redis container.
// Reuse the frozen F1-10e request/response and DB helpers; use a compliant, unique app_id here.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seed } from '../../admin/accounts/kit.ts';
import { fixture, signedIn, useHarness } from '../../admin/auth/kit.ts';
import {
  OPERATIONS,
  alertsSince,
  auditsSince,
  batch,
  current,
  expectAlerted,
  expectAudit,
  hasRoute,
  listAll,
  member,
  needsTotp,
  putRow,
  rejected,
  rollback,
  snapshot,
  stepUp,
  success,
  update,
  valueInvalid,
  versionsOf,
  written,
  type Item,
} from '../config-items/kit.ts';
import { DEFAULTS, SETTLE } from './oracle.ts';

const h = useHarness();

async function setup() {
  const f = await fixture(h);
  for (const op of OPERATIONS) expect(hasRoute(f.app, op), op).toBe(true);
  const appId = `f102zj_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  return { ...f, appId, actor, token: session.admin_token };
}

it('[AC-F1-02zj#8] PUT bill_day=29 或 24.5：20001 [value]，当前值、历史、审计和告警不变', async () => {
  const f = await setup();
  const key = 'settle.bill_day';
  await putRow(h, f.appId, key, 24);
  const extra = { stepUp: await stepUp(f) };
  const before = await snapshot(h, f.appId);
  const seen = f.lines.length;
  for (const value of [29, 24.5]) {
    await valueInvalid(await update(f, key, { value, expected_version: 1 }, extra), 'update');
    expect(await snapshot(h, f.appId)).toStrictEqual(before);
    expect(alertsSince(f.lines, seen)).toStrictEqual([]);
  }
});

it('[AC-F1-02zj#9] config.business 经 TOTP 保存 bill_day=22，历史与审计各增加一行', async () => {
  const f = await setup();
  const key = 'settle.bill_day';
  await putRow(h, f.appId, key, 24);
  const { who, token } = await member(h, f, ['config.business']);
  const caller = { ...f, token };
  const body = { value: 22, expected_version: 1, reason: '调整月结账单日' };
  await needsTotp(await update(caller, key, body), 'update');
  const extra = { stepUp: await stepUp(f, who, token) };
  const before = await snapshot(h, f.appId);
  const seen = f.lines.length;
  const item = await success<Item>(await update(caller, key, body, extra), 'update');
  expect(item).toMatchObject({
    key,
    value: 22,
    version: 2,
    permission: 'config.business',
    admin_editable: true,
    updated_by: who.username,
    updated_at: f.clock.now().toISOString(),
  });
  expect(await current(h, f.appId, key)).toMatchObject({ value: 22, version: 2 });
  const history = await versionsOf(h, f.appId, key);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    version: 2,
    value: 22,
    updated_by_admin_id: who.id,
    reason: body.reason,
  });
  expect(history[0]!.created_at.toISOString()).toBe(f.clock.now().toISOString());
  const audits = await auditsSince(h, f.appId, before);
  expect(audits).toHaveLength(1);
  expectAudit(audits[0]!, f, who, 'config_item_change', {
    key,
    from: 1,
    to: 2,
    before: 24,
    after: 22,
    reason: body.reason,
  });
  expectAlerted(f.lines, seen, [key]);
  expect(alertsSince(f.lines, seen)).toHaveLength(1);
});

it.each([
  ['settle.batch.max_orders', 0],
  ['settle.batch.max_orders', 1.5],
  ['settle.statement_source.jd', 'API'],
] as const)(
  '[AC-F1-02zj#10] batch %s=%j 混合法 bill_day：20001 只列失败键，整批不写、不审计、不告警',
  async (key, value) => {
    const f = await setup();
    await putRow(h, f.appId, 'settle.bill_day', 24);
    const extra = { stepUp: await stepUp(f) };
    const before = await snapshot(h, f.appId);
    const seen = f.lines.length;
    const items = [
      { key: 'settle.bill_day', value: 22, expected_version: 1 },
      { key, value, expected_version: 0 },
    ];
    // Exercise both request orders: a valid entry before a bad one must not leak writes.
    for (const ordered of [items, [...items].reverse()]) {
      await rejected(await batch(f, { items: ordered }, extra), 'batch', 20001, { fields: [key] });
      expect(await snapshot(h, f.appId)).toStrictEqual(before);
      expect(alertsSince(f.lines, seen)).toStrictEqual([]);
    }
  },
);

it.each([
  ['settle.bill_day', 30, 24],
  ['settle.bill_day', 24.5, 24],
  ['settle.statement_source.taobao', 'API', 'api'],
] as const)(
  '[AC-F1-02zj#11] rollback %s 到历史 %j：20001 [to_version]，当前值、历史、审计和告警不变',
  async (key, invalid, valid) => {
    const f = await setup();
    // Historical values may predate registration: write them directly via the SQL fixture.
    await written(h, f.appId, key, [invalid, valid], f.actor);
    const extra = { stepUp: await stepUp(f) };
    const before = await snapshot(h, f.appId);
    const seen = f.lines.length;
    await rejected(
      await rollback(f, key, { to_version: 1, expected_version: 2 }, extra),
      'rollback',
      20001,
      { fields: ['to_version'] },
    );
    expect(await snapshot(h, f.appId)).toStrictEqual(before);
    expect(alertsSince(f.lines, seen)).toStrictEqual([]);
  },
);

it('[AC-F1-02zj#12] batch 可保存全部 16 项；rollback 可恢复范围内的历史值', async () => {
  const f = await setup();
  const extra = { stepUp: await stepUp(f) };
  const items = DEFAULTS.map(([key, value]) => ({ key, value, expected_version: 0 }));
  const before = await snapshot(h, f.appId);
  const result = await success<{ items: Item[] }>(await batch(f, { items }, extra), 'batch');
  expect(result.items.map(({ key, value, version }) => [key, value, version])).toStrictEqual(
    DEFAULTS.map(([key, value]) => [key, value, 1]),
  );
  for (const [key, value] of DEFAULTS) {
    expect(await current(h, f.appId, key)).toMatchObject({ value, version: 1 });
    expect(await versionsOf(h, f.appId, key)).toHaveLength(1);
  }
  expect(await auditsSince(h, f.appId, before)).toHaveLength(16);

  const key = 'settle.bill_day';
  await success<Item>(
    await update(f, key, { value: 28, expected_version: 1 }, { stepUp: await stepUp(f) }),
    'update',
  );
  const oldHistory = await versionsOf(h, f.appId, key);
  const rollbackToken = { stepUp: await stepUp(f) };
  const beforeRollback = await snapshot(h, f.appId);
  const restored = await success<Item>(
    await rollback(f, key, { to_version: 1, expected_version: 2 }, rollbackToken),
    'rollback',
  );
  expect(restored).toMatchObject({ key, value: 24, version: 3 });
  const history = await versionsOf(h, f.appId, key);
  expect(history).toHaveLength(3);
  expect(history.slice(0, 2)).toStrictEqual(oldHistory);
  expect(history[2]).toMatchObject({ value: 24, version: 3 });
  const audits = await auditsSince(h, f.appId, beforeRollback);
  expect(audits).toHaveLength(1);
  expectAudit(audits[0]!, f, f.actor, 'config_item_rollback', {
    key,
    from: 2,
    to: 3,
    before: 28,
    after: 24,
  });
});

it('[AC-F1-02zj#13] GET 配置列表包含全部 16 项，enum 选项按契约返回', async () => {
  const f = await setup();
  const items = await listAll(f);
  expect(items.slice(-16).map((item) => item.key)).toStrictEqual(SETTLE.map((entry) => entry.key));
  for (const expected of SETTLE) {
    const found = items.filter((item) => item.key === expected.key);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      value_type: expected.valueType,
      options: expected.options,
      permission: expected.permission,
      admin_editable: true,
      value: null,
      version: 0,
    });
  }
});
