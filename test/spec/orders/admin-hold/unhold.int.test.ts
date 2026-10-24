import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ADMIN_NAME,
  CONFLICT,
  IP,
  NOTE,
  NOW,
  fieldsError,
  fixture,
  open,
  type Fixture,
  type Harness,
  type Order,
} from './kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

const RESUME = '核实无异常，恢复结算';
const NO_HOLD = {
  last_hold_by: null,
  last_hold_by_name: null,
  last_hold_note: null,
  last_hold_at: null,
};

async function unheld(f: Fixture, o: Order, from: string, reason: 'RISK' | 'CS') {
  const before = await f.state();
  const result = await f.unhold(o, { reason_code: reason, note: RESUME });
  expect(result).toMatchObject({
    code: 0,
    data: {
      order_id: o.order_id,
      rebate_status: o.rebate_status,
      hold_reason: null,
      flags: { hold: false },
      row_version: o.row_version + 1,
      unmapped_pending_open: false,
    },
  });
  expect(f.rebate.adminUnhold).toHaveBeenCalledTimes(1);
  expect(f.rebate.adminHold).not.toHaveBeenCalled();
  expect(f.calls.map((c) => c.input)).toEqual([
    {
      before: o,
      expected_row_version: o.row_version,
      reason_code: reason,
      reason: RESUME,
      actor: f.adminId,
      ip: IP,
      now: f.clock.now(),
    },
  ]);
  const after = await f.state();
  const others = (s: typeof before) => s.orders.filter((r) => r.order_id !== o.order_id);
  expect(after.orders.find((r) => r.order_id === o.order_id)).toEqual({
    ...o,
    hold: false,
    hold_reason: null,
    row_version: o.row_version + 1,
    updated_at: f.clock.now(),
  });
  expect(others(after)).toEqual(others(before));
  expect(after.history).toEqual(before.history);
  expect(after.pending).toEqual(before.pending);
  expect(after.audits).toHaveLength(1);
  expect(after.audits[0]).toMatchObject({
    app_id: f.appId,
    admin_id: f.adminId,
    action: 'order_unhold',
    target: `orders:${o.order_id}`,
    ip: IP,
    at: f.clock.now(),
  });
  expect(after.audits[0]?.before).toMatchObject({ hold: true, hold_reason: from });
  expect(after.audits[0]?.after).toMatchObject({
    hold: false,
    hold_reason: null,
    reason_code: reason,
    note: RESUME,
  });
  return result;
}

it.each<[string, string, 'RISK' | 'CS']>([
  ['ESTIMATED', 'RISK', 'CS'],
  ['WAITING', 'CS', 'RISK'],
  ['ESTIMATED', 'CS', 'CS'],
])(
  '[AC-B1-09l#16] %s 的人工 %s 暂停由操作人选 %s unhold：经返利端口写，审计 order_unhold，返回当前详情',
  async (status, from, reason) => {
    const f = await fixture(h);
    const o = await f.order({ rebate_status: status, hold: true, hold_reason: from });
    const result = await unheld(f, o, from, reason);
    expect(result).toMatchObject({ code: 0, data: NO_HOLD });
  },
);

it.each(['ESTIMATED', 'WAITING'])(
  '[AC-B1-09l#17] %s 未暂停时 unhold（同状态）：20902 order，订单不变、不写 history、不审计',
  async (status) => {
    const f = await fixture(h);
    const o = await f.order({ rebate_status: status });
    const before = await f.state();
    expect(await f.unhold(o)).toEqual(CONFLICT);
    expect(await f.state()).toEqual(before);
  },
);

it.each([
  ['VOID', 'CS'],
  ['VOID', 'UNMAPPED_STATUS'],
  ['CREDITED', 'RISK'],
  ['CLAWED_BACK', 'CS'],
  ['UNATTRIBUTED', 'RISK'],
])(
  '[AC-B1-09l#18] 暂停后转到 %s（%s 标记保留，不提供解除）：unhold 返回 20902 order，什么都不写',
  async (status, reason) => {
    const f = await fixture(h);
    const o = await f.order({
      rebate_status: status,
      hold: true,
      hold_reason: reason,
      ...(status === 'UNATTRIBUTED' ? { user_id: null, user_basis: null, buy_type: null } : {}),
    });
    const before = await f.state();
    expect(await f.unhold(o)).toEqual(CONFLICT);
    expect(await f.state()).toEqual(before);
  },
);

it.each([
  ['待处理记录带 order_id', true],
  ['待处理记录只按子订单号登记（order_id 为空）', false],
])(
  '[AC-B1-09l#19] 系统 UNMAPPED_STATUS 暂停而同子订单 UNMAPPED_STATUS 待处理记录 open：unhold 返回 20902 order，不调端口、什么都不写（%s）',
  async (_label, linked) => {
    const f = await fixture(h);
    const o = await f.order({ hold: true, hold_reason: 'UNMAPPED_STATUS' });
    await f.pending(o, { status: 'resolved', detected_at: f.clock.now() });
    await f.pending(o, linked ? {} : { order_id: null });
    const before = await f.state();
    for (const reason of ['RISK', 'CS']) {
      expect(await f.unhold(o, { reason_code: reason })).toEqual(CONFLICT);
    }
    expect(f.rebate.adminUnhold).not.toHaveBeenCalled();
    expect(await f.state()).toEqual(before);
  },
);

type Arrange = (f: Fixture, o: Order) => Promise<void>;

it.each<[string, Arrange]>([
  ['待处理记录已 resolved', (f, o) => f.pending(o, { status: 'resolved' })],
  ['待处理记录已 dismissed', (f, o) => f.pending(o, { status: 'dismissed' })],
  ['open 的是别的原因', (f, o) => f.pending(o, { reason: 'ILLEGAL_TRANSITION' })],
  ['从没有待处理记录', async () => undefined],
  [
    'open 的是同应用别的子订单',
    async (f) => {
      await f.pending(await f.order());
    },
  ],
  [
    'open 的是别的应用同号子订单',
    (f, o) => f.pending(o, { app_id: `${f.appId}_other`, order_id: null }),
  ],
])(
  '[AC-B1-09l#20] UNMAPPED_STATUS 暂停在待处理记录关闭后照常由人工 unhold：%s',
  async (_label, arrange) => {
    const f = await fixture(h);
    const o = await f.order({ hold: true, hold_reason: 'UNMAPPED_STATUS' });
    await arrange(f, o);
    const result = await unheld(f, o, 'UNMAPPED_STATUS', 'RISK');
    expect(result).toMatchObject({ code: 0, data: NO_HOLD });
  },
);

it('[AC-B1-09l#21] 人工 CS 暂停时同子订单另有 open 的 UNMAPPED_STATUS 记录不挡 unhold', async () => {
  const f = await fixture(h);
  const o = await f.order({ hold: true, hold_reason: 'CS' });
  await f.pending(o);
  await unheld(f, o, 'CS', 'CS');
});

it.each<[string, readonly string[], string | undefined]>([
  ['只持 risk.freeze 也必须选，不传', ['order.hold', 'risk.freeze'], undefined],
  ['只持 order.claim 也必须选，不传', ['order.hold', 'order.claim'], undefined],
  ['传 UNMAPPED_STATUS', ['order.hold', 'order.claim'], 'UNMAPPED_STATUS'],
  ['传小写 risk', ['order.hold', 'risk.freeze'], 'risk'],
])(
  '[AC-B1-09l#22] unhold 原因码必选且只收 RISK、CS：%s → 20001 reason_code，不调端口、什么都不写',
  async (_label, keys, sent) => {
    const f = await fixture(h);
    f.grants.keys = keys;
    const o = await f.order({ hold: true, hold_reason: 'RISK' });
    const before = await f.state();
    const result = await f.unhold(o, { reason_code: sent });
    expect(result).toEqual(fieldsError('reason_code'));
    expect(f.rebate.adminUnhold).not.toHaveBeenCalled();
    expect(await f.state()).toEqual(before);
  },
);

it.each<[string, readonly string[], 'RISK' | 'CS']>([
  ['只持 risk.freeze 选 CS', ['order.hold', 'risk.freeze'], 'CS'],
  ['只持 order.claim 选 RISK', ['order.hold', 'order.claim'], 'RISK'],
])(
  '[AC-B1-09l#23] unhold 原因码由操作人在 RISK、CS 中选，不受权限推导约束：%s',
  async (_label, keys, reason) => {
    const f = await fixture(h);
    f.grants.keys = keys;
    const o = await f.order({ hold: true, hold_reason: 'RISK' });
    await unheld(f, o, 'RISK', reason);
  },
);

it.each([
  ['空说明', ''],
  ['201 字说明', 'x'.repeat(201)],
])('[AC-B1-09l#24] unhold 的%s → 20001 note，不调端口、什么都不写', async (_label, note) => {
  const f = await fixture(h);
  const o = await f.order({ hold: true, hold_reason: 'CS' });
  const before = await f.state();
  expect(await f.unhold(o, { note })).toEqual(fieldsError('note'));
  expect(f.rebate.adminUnhold).not.toHaveBeenCalled();
  expect(await f.state()).toEqual(before);
});

it.each([-1, 1])(
  '[AC-B1-09l#25] expected_row_version 与锁内重读不符（偏 %i）：unhold 返回 20902 order，什么都不写',
  async (offset) => {
    const f = await fixture(h);
    const o = await f.order({ hold: true, hold_reason: 'RISK', row_version: 5 });
    const before = await f.state();
    expect(await f.unhold(o, { expected_row_version: o.row_version + offset })).toEqual(CONFLICT);
    expect(await f.state()).toEqual(before);
  },
);

it('[AC-B1-09l#26] 经用例 hold 再 unhold：详情仍显示最近一次人工暂停的操作人与说明', async () => {
  const f = await fixture(h);
  const o = await f.order();
  expect(await f.hold(o)).toMatchObject({ code: 0, data: { row_version: o.row_version + 1 } });
  const held = (await f.state()).orders[0]!;
  const result = await f.unhold(
    held,
    { reason_code: 'RISK', note: RESUME },
    { actor: { ip: null } },
  );
  expect(result).toMatchObject({
    code: 0,
    data: {
      hold_reason: null,
      flags: { hold: false },
      row_version: o.row_version + 2,
      last_hold_by: f.adminId,
      last_hold_by_name: ADMIN_NAME,
      last_hold_note: NOTE,
      last_hold_at: NOW,
    },
  });
  const audits = (await f.state()).audits;
  expect(audits.map((a) => [a.action, a.target, a.ip])).toEqual([
    ['order_hold', `orders:${o.order_id}`, IP],
    ['order_unhold', `orders:${o.order_id}`, null],
  ]);
  expect(audits[1]?.after).toMatchObject({ reason_code: 'RISK', note: RESUME });
});
