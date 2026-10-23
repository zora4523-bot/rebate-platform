import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect, it } from 'vitest';
import { account, useHarness } from '../../admin/auth/kit.ts';
import {
  NO_HOLD,
  UNHOLD,
  audit,
  detail,
  order,
  pending,
  setup,
  type Order,
  type Scenario,
} from './kit.ts';

const h = useHarness();
const UNMAPPED = { hold: true, hold_reason: 'UNMAPPED_STATUS' };

it.each([
  ['待处理记录带 order_id', true],
  ['待处理记录只按子订单号登记（order_id 为空）', false],
])(
  '[AC-B1-10i#36] 系统 UNMAPPED_STATUS 暂停且同子订单 UNMAPPED_STATUS 待处理记录 open → unmapped_pending_open=true：%s',
  async (_label, linked) => {
    const s = await setup(h);
    const o = await order(s, UNMAPPED);
    await pending(s, o, { status: 'resolved', detected_at: '2026-10-06T00:00:00.000Z' });
    await pending(s, o, linked ? {} : { order_id: null });
    expect(await detail(await s.get({}, o.order_id))).toMatchObject({
      hold_reason: 'UNMAPPED_STATUS',
      flags: { hold: true },
      unmapped_pending_open: true,
      ...NO_HOLD,
    });
  },
);

type Arrange = (s: Scenario, o: Order) => Promise<void>;

it.each<[string, Partial<Insertable<DB['orders']>>, Arrange]>([
  ['待处理记录已 resolved', UNMAPPED, (s, o) => pending(s, o, { status: 'resolved' })],
  ['待处理记录已 dismissed', UNMAPPED, (s, o) => pending(s, o, { status: 'dismissed' })],
  ['open 的是别的原因', UNMAPPED, (s, o) => pending(s, o, { reason: 'ILLEGAL_TRANSITION' })],
  ['没有待处理记录', UNMAPPED, async () => undefined],
  ['当前是人工 CS 暂停', { hold: true, hold_reason: 'CS' }, (s, o) => pending(s, o)],
  ['未暂停', {}, (s, o) => pending(s, o)],
  [
    'open 的是同应用别的子订单',
    UNMAPPED,
    async (s) => {
      await pending(s, await order(s));
    },
  ],
  [
    'open 的是别的应用同号子订单',
    UNMAPPED,
    (s, o) => pending(s, o, { app_id: `${s.appId}_other`, order_id: null }),
  ],
])('[AC-B1-10i#37] %s → unmapped_pending_open=false', async (_label, patch, arrange) => {
  const s = await setup(h);
  const o = await order(s, patch);
  await arrange(s, o);
  expect((await detail(await s.get({}, o.order_id))).unmapped_pending_open).toBe(false);
});

it('[AC-B1-10i#38] 从未人工暂停的订单 last_hold_* 四项为 null', async () => {
  const s = await setup(h);
  const o = await order(s);
  expect(await detail(await s.get({}, o.order_id))).toMatchObject(NO_HOLD);
});

it('[AC-B1-10i#39] last_hold_* 取本订单最近一次人工暂停审计；恢复、其他动作、其他订单与其他应用的记录不算', async () => {
  const s = await setup(h);
  const lin = await account(h, { app_id: s.appId, display_name: '客服小林' });
  const wang = await account(h, { app_id: s.appId, display_name: null });
  const o = await order(s, { hold: true, hold_reason: 'RISK' });
  const other = await order(s);
  await audit(s, {
    adminId: lin.id,
    orderId: o.order_id,
    at: '2026-10-07T01:00:00.000Z',
    note: '第一次暂停',
  });
  await audit(s, {
    adminId: lin.id,
    orderId: o.order_id,
    at: '2026-10-07T02:00:00.000Z',
    note: '核实无误恢复',
    action: UNHOLD,
  });
  await audit(s, {
    adminId: wang.id,
    orderId: o.order_id,
    at: '2026-10-07T03:00:00.000Z',
    note: '风控要求再次暂停',
    reason: 'RISK',
  });
  await audit(s, {
    adminId: lin.id,
    orderId: o.order_id,
    at: '2026-10-07T04:00:00.000Z',
    note: '无关动作',
    action: 'order_reassign',
  });
  await audit(s, {
    adminId: lin.id,
    orderId: other.order_id,
    at: '2026-10-07T05:00:00.000Z',
    note: '别的订单',
  });
  const foreignApp = `${s.appId}_other`;
  const foreign = await account(h, { app_id: foreignApp });
  await audit(s, {
    adminId: foreign.id,
    orderId: o.order_id,
    at: '2026-10-07T06:00:00.000Z',
    note: '别的应用',
    appId: foreignApp,
  });
  expect(await detail(await s.get({}, o.order_id))).toMatchObject({
    hold_reason: 'RISK',
    unmapped_pending_open: false,
    last_hold_by: wang.id,
    last_hold_by_name: wang.username,
    last_hold_note: '风控要求再次暂停',
    last_hold_at: '2026-10-07T03:00:00.000Z',
  });
});

it('[AC-B1-10i#40] 人工暂停后已恢复的订单仍显示最近一次人工暂停', async () => {
  const s = await setup(h);
  const lin = await account(h, { app_id: s.appId, display_name: '客服小林' });
  const o = await order(s, { hold: false, hold_reason: null });
  await audit(s, {
    adminId: lin.id,
    orderId: o.order_id,
    at: '2026-10-07T01:00:00.000Z',
    note: '用户反映订单异常，先暂停核实',
  });
  await audit(s, {
    adminId: s.a.id,
    orderId: o.order_id,
    at: '2026-10-07T02:00:00.000Z',
    note: '核实无误恢复',
    action: UNHOLD,
  });
  expect(await detail(await s.get({}, o.order_id))).toMatchObject({
    hold_reason: null,
    flags: { hold: false },
    last_hold_by: lin.id,
    last_hold_by_name: '客服小林',
    last_hold_note: '用户反映订单异常，先暂停核实',
    last_hold_at: '2026-10-07T01:00:00.000Z',
  });
});

it('[AC-B1-10i#41] 当前为系统 UNMAPPED_STATUS 暂停时，即使有更早的人工暂停审计 last_hold_* 也全为 null', async () => {
  const s = await setup(h);
  const lin = await account(h, { app_id: s.appId, display_name: '客服小林' });
  const o = await order(s, UNMAPPED);
  await audit(s, {
    adminId: lin.id,
    orderId: o.order_id,
    at: '2026-10-06T01:00:00.000Z',
    note: '早先的人工暂停',
  });
  await audit(s, {
    adminId: lin.id,
    orderId: o.order_id,
    at: '2026-10-06T02:00:00.000Z',
    note: '恢复',
    action: UNHOLD,
  });
  await pending(s, o);
  expect(await detail(await s.get({}, o.order_id))).toMatchObject({
    hold_reason: 'UNMAPPED_STATUS',
    unmapped_pending_open: true,
    ...NO_HOLD,
  });
});

it('[AC-B1-10i#42] 操作人名字取当前展示名，无展示名回落登录名', async () => {
  const s = await setup(h);
  const wang = await account(h, { app_id: s.appId, display_name: null });
  const o = await order(s, { hold: true, hold_reason: 'CS' });
  await audit(s, {
    adminId: wang.id,
    orderId: o.order_id,
    at: '2026-10-07T01:00:00.000Z',
    note: '暂停核实',
  });
  expect((await detail(await s.get({}, o.order_id))).last_hold_by_name).toBe(wang.username);
  await h.db
    .updateTable('admin_users')
    .set({ display_name: '客服新名字' })
    .where('id', '=', wang.id)
    .execute();
  expect((await detail(await s.get({}, o.order_id))).last_hold_by_name).toBe('客服新名字');
});
