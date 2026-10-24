import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture as baseFixture } from '../list-detail/kit.ts';
import {
  ADMIN_NAME,
  CONFLICT,
  IP,
  NOTE,
  NOW,
  fieldsError,
  fixture,
  open,
  type Harness,
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

it.each(['ESTIMATED', 'WAITING'])(
  '[AC-B1-09l#8] %s 未暂停的订单 hold：经返利端口写，审计 order_hold 带原因码与说明，返回当前订单详情',
  async (status) => {
    const f = await fixture(h);
    const o = await f.order({ rebate_status: status });
    const before = await f.state();
    const result = await f.hold(o);
    expect(result).toMatchObject({
      code: 0,
      data: {
        order_id: o.order_id,
        rebate_status: status,
        hold_reason: 'CS',
        flags: { hold: true },
        row_version: o.row_version + 1,
        unmapped_pending_open: false,
        last_hold_by: f.adminId,
        last_hold_by_name: ADMIN_NAME,
        last_hold_note: NOTE,
        last_hold_at: NOW,
      },
    });
    expect(f.rebate.adminHold).toHaveBeenCalledTimes(1);
    expect(f.rebate.adminUnhold).not.toHaveBeenCalled();
    expect(f.calls.map((c) => c.input)).toEqual([
      {
        before: o,
        expected_row_version: o.row_version,
        reason_code: 'CS',
        reason: NOTE,
        actor: f.adminId,
        ip: IP,
        now: f.clock.now(),
      },
    ]);
    const after = await f.state();
    // Only settlement's write: orders adds no column of its own, R11 books no history.
    expect(after.orders).toEqual([
      {
        ...o,
        hold: true,
        hold_reason: 'CS',
        row_version: o.row_version + 1,
        updated_at: f.clock.now(),
      },
    ]);
    expect(after.history).toEqual(before.history);
    expect(after.pending).toEqual(before.pending);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({
      app_id: f.appId,
      admin_id: f.adminId,
      action: 'order_hold',
      target: `orders:${o.order_id}`,
      ip: IP,
      at: f.clock.now(),
    });
    expect(after.audits[0]?.before).toMatchObject({ hold: false, hold_reason: null });
    expect(after.audits[0]?.after).toMatchObject({
      hold: true,
      hold_reason: 'CS',
      reason_code: 'CS',
      note: NOTE,
    });
  },
);

it.each(['UNATTRIBUTED', 'CREDITED', 'VOID', 'CLAWED_BACK'])(
  '[AC-B1-09l#9] %s 不是 R11 起点：hold 返回 20902 order，订单不变、不写 history、不审计',
  async (status) => {
    const f = await fixture(h);
    const o = await f.order({
      rebate_status: status,
      ...(status === 'UNATTRIBUTED' ? { user_id: null, user_basis: null, buy_type: null } : {}),
    });
    const before = await f.state();
    expect(await f.hold(o)).toEqual(CONFLICT);
    expect(await f.state()).toEqual(before);
  },
);

it.each([
  ['人工 CS', 'ESTIMATED', 'CS'],
  ['人工 RISK', 'WAITING', 'RISK'],
  ['系统 UNMAPPED_STATUS', 'ESTIMATED', 'UNMAPPED_STATUS'],
])(
  '[AC-B1-09l#10] 已%s暂停再 hold（同状态）：20902 order，订单不变、不写 history、不审计',
  async (_label, status, reason) => {
    const f = await fixture(h);
    const o = await f.order({ rebate_status: status, hold: true, hold_reason: reason });
    const before = await f.state();
    expect(await f.hold(o)).toEqual(CONFLICT);
    expect(await f.state()).toEqual(before);
  },
);

it.each([-1, 1])(
  '[AC-B1-09l#11] expected_row_version 与锁内重读不符（偏 %i）：hold 返回 20902 order，什么都不写',
  async (offset) => {
    const f = await fixture(h);
    const o = await f.order({ row_version: 3 });
    const before = await f.state();
    expect(await f.hold(o, { expected_row_version: o.row_version + offset })).toEqual(CONFLICT);
    expect(await f.state()).toEqual(before);
  },
);

it.each<[string, readonly string[], boolean, 'RISK' | 'CS' | undefined, 'RISK' | 'CS']>([
  ['只持 risk.freeze，不传', ['order.hold', 'risk.freeze'], false, undefined, 'RISK'],
  ['只持 order.claim，不传', ['order.hold', 'order.claim'], false, undefined, 'CS'],
  [
    '持 config.risk 与 order.claim（config.risk 不算 risk.*），不传',
    ['order.hold', 'config.risk', 'order.claim'],
    false,
    undefined,
    'CS',
  ],
  ['只持 risk.appeal，传相同的 RISK', ['order.hold', 'risk.appeal'], false, 'RISK', 'RISK'],
  ['两类都持有，选 RISK', ['order.hold', 'risk.ban', 'order.claim'], false, 'RISK', 'RISK'],
  ['两类都没有，选 CS', ['order.hold'], false, 'CS', 'CS'],
  ['超管，选 RISK', [], true, 'RISK', 'RISK'],
])(
  '[AC-B1-09l#12] hold 原因码按操作人权限推导或由其选择：%s → %s 写进端口与订单',
  async (_label, keys, isSuper, sent, expected) => {
    const f = await fixture(h);
    f.grants.keys = keys;
    const o = await f.order();
    const result = await f.hold(o, sent === undefined ? {} : { reason_code: sent }, {
      actor: { isSuper },
    });
    expect(result).toMatchObject({ code: 0, data: { hold_reason: expected } });
    expect(f.calls.map((c) => c.input.reason_code)).toEqual([expected]);
    const after = await f.state();
    expect(after.orders[0]).toMatchObject({ hold: true, hold_reason: expected });
    expect(after.audits[0]?.after).toMatchObject({ hold_reason: expected, reason_code: expected });
  },
);

it.each<[string, readonly string[], boolean, string | undefined]>([
  ['推得 RISK 却传 CS', ['order.hold', 'risk.freeze'], false, 'CS'],
  ['推得 CS 却传 RISK', ['order.hold', 'order.claim'], false, 'RISK'],
  ['两类都持有而不传', ['order.hold', 'risk.blocklist', 'order.claim'], false, undefined],
  ['两类都没有而不传', ['order.hold'], false, undefined],
  ['只持 config.risk 而不传', ['order.hold', 'config.risk'], false, undefined],
  ['超管不传', [], true, undefined],
  ['传 UNMAPPED_STATUS', ['order.hold', 'order.claim'], false, 'UNMAPPED_STATUS'],
  ['传表外值', ['order.hold', 'risk.ban', 'order.claim'], false, 'OTHER'],
])(
  '[AC-B1-09l#13] hold 原因码不成立：%s → 20001 reason_code，不调端口、什么都不写',
  async (_label, keys, isSuper, sent) => {
    const f = await fixture(h);
    f.grants.keys = keys;
    const o = await f.order();
    const before = await f.state();
    const result = await f.hold(o, sent === undefined ? {} : { reason_code: sent }, {
      actor: { isSuper },
    });
    expect(result).toEqual(fieldsError('reason_code'));
    expect(f.rebate.adminHold).not.toHaveBeenCalled();
    expect(await f.state()).toEqual(before);
  },
);

it.each([
  ['空说明', ''],
  ['201 字说明', '暂'.repeat(201)],
])(
  '[AC-B1-09l#14] hold 的%s → 20001 note，不调端口、什么都不写；200 字照常受理',
  async (_label, note) => {
    const f = await fixture(h);
    const o = await f.order();
    const before = await f.state();
    expect(await f.hold(o, { note })).toEqual(fieldsError('note'));
    expect(f.rebate.adminHold).not.toHaveBeenCalled();
    expect(await f.state()).toEqual(before);
    const longest = '暂'.repeat(200);
    expect(await f.hold(o, { note: longest })).toMatchObject({
      code: 0,
      data: { last_hold_note: longest },
    });
    expect((await f.state()).audits[0]?.after).toMatchObject({ note: longest });
  },
);

it.each(['不是 UUID', '本应用没有的 UUID', '别的应用的订单'])(
  '[AC-B1-09l#15] hold 的 order_id %s → 20001 order_id，不调端口、什么都不写',
  async (label) => {
    const f = await fixture(h);
    const own = await f.order();
    const other = await baseFixture(h.db);
    const foreign = await other.seed();
    const orderId =
      label === '不是 UUID'
        ? 'not-a-uuid'
        : label === '本应用没有的 UUID'
          ? randomUUID()
          : foreign.order_id;
    const before = await f.state();
    const foreignBefore = await h.db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', foreign.app_id)
      .execute();
    expect(await f.hold(own, { orderId })).toEqual(fieldsError('order_id'));
    expect(f.rebate.adminHold).not.toHaveBeenCalled();
    expect(await f.state()).toEqual(before);
    expect(
      await h.db.selectFrom('orders').selectAll().where('app_id', '=', foreign.app_id).execute(),
    ).toEqual(foreignBefore);
  },
);
