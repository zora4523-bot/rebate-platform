import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  NO_HOLD,
  SPLIT_AT,
  UNATTRIBUTED,
  detail,
  history,
  linkLogs,
  order,
  setup,
  split,
} from './kit.ts';

const h = useHarness();

it('[AC-B1-10i#31] 详情含列表字段及商品、数量、归因、时间字段，照 orders 列输出', async () => {
  const s = await setup(h);
  const o = await order(s, {
    platform: 'taobao',
    title: '保温杯 500ml',
    image_url: 'https://img.example.com/p/b2.jpg',
    raw_item_id: '61234',
    product_key: 'tb:61234',
    quantity: 2,
    refunded_quantity: 1,
    pay_amount_fen: 12900n,
    est_commission_fen: 1032n,
    settle_commission_fen: 990n,
    platform_status: 'SETTLED',
    rebate_status: 'WAITING',
    reason: 'PART_REFUND',
    buy_type: 'share',
    scene_basis: 'pid',
    user_basis: 'claim',
    is_presale: true,
    deposit_paid_at: '2026-10-04T01:00:00.000Z',
    paid_at: '2026-10-05T02:00:00.000Z',
    received_at: '2026-10-07T03:00:00.000Z',
    settled_at: '2026-10-08T04:00:00.000Z',
    credited_at: null,
    settle_period: '2026-10',
    commission_rate_bp: 800,
    row_version: 4,
    locked: true,
    rights_pending: true,
  });
  expect(await detail(await s.get({}, o.order_id))).toEqual({
    order_id: o.order_id,
    sub_order_id: o.sub_order_id,
    parent_order_id: o.parent_order_id,
    platform: 'taobao',
    title: '保温杯 500ml',
    image_url: 'https://img.example.com/p/b2.jpg',
    user: { user_id: s.userId, phone_masked: null },
    paid_at: '2026-10-05T02:00:00.000Z',
    pay_amount_fen: 12900,
    est_commission_fen: 1032,
    settle_commission_fen: 990,
    platform_status: 'SETTLED',
    rebate_status: 'WAITING',
    hold_reason: null,
    flags: { locked: true, status_locked: false, rights_pending: true, hold: false },
    raw_item_id: '61234',
    product_key: 'tb:61234',
    quantity: 2,
    refunded_quantity: 1,
    display_status: expect.any(String),
    reason: 'PART_REFUND',
    buy_type: 'share',
    scene_basis: 'pid',
    user_basis: 'claim',
    is_presale: true,
    deposit_paid_at: '2026-10-04T01:00:00.000Z',
    received_at: '2026-10-07T03:00:00.000Z',
    settled_at: '2026-10-08T04:00:00.000Z',
    credited_at: null,
    settle_period: '2026-10',
    commission_rate_bp: 800,
    row_version: 4,
    unmapped_pending_open: false,
    ...NO_HOLD,
    status_history: [],
    commission_split: null,
    link_logs: [],
  });
});

it.each<[string, Partial<Insertable<DB['orders']>>, string | null]>([
  ['UNATTRIBUTED', { ...UNATTRIBUTED, hold: true, hold_reason: 'RISK' }, null],
  [
    'VOID',
    { rebate_status: 'VOID', platform_status: 'INVALID', hold: true, hold_reason: 'CS' },
    'INVALID',
  ],
  [
    'CLAWED_BACK',
    { rebate_status: 'CLAWED_BACK', platform_status: 'INVALID', hold: true, hold_reason: 'CS' },
    'CLAWED_BACK',
  ],
])(
  '[AC-B1-10i#32] %s 订单的 display_status 按 BR-FUND-17 派生为 %s，优先于暂停',
  async (status, patch, displayed) => {
    const s = await setup(h);
    const o = await order(s, patch);
    const d = await detail(await s.get({}, o.order_id));
    expect(d.display_status).toBe(displayed);
    expect(d.flags).toEqual({
      locked: false,
      status_locked: status !== 'UNATTRIBUTED',
      rights_pending: false,
      hold: true,
    });
    if (status === 'UNATTRIBUTED') {
      expect(d).toMatchObject({
        user: null,
        user_basis: null,
        buy_type: null,
        scene_basis: null,
        commission_split: null,
      });
    }
  },
);

it('[AC-B1-10i#33] status_history 只列本订单的记录，按发生时间从早到晚，首个值 from 为 null', async () => {
  const s = await setup(h);
  const o = await order(s, { platform_status: 'RECEIVED', rebate_status: 'WAITING' });
  const other = await order(s);
  await history(s, other.order_id, [
    {
      field: 'platform',
      from_status: null,
      to_status: 'PAID',
      event: 'P2',
      source: 'sync',
      at: '2026-10-05T00:00:00.000Z',
    },
  ]);
  await history(s, o.order_id, [
    {
      field: 'rebate',
      from_status: 'ESTIMATED',
      to_status: 'WAITING',
      event: 'R3',
      source: 'system',
      at: '2026-10-07T03:00:00.000Z',
    },
    {
      field: 'platform',
      from_status: null,
      to_status: 'PAID',
      event: 'P2',
      source: 'sync',
      at: '2026-10-06T02:58:40.000Z',
    },
    {
      field: 'rebate',
      from_status: 'UNATTRIBUTED',
      to_status: 'ESTIMATED',
      event: 'R1',
      source: 'admin',
      at: '2026-10-06T03:00:00.000Z',
    },
    {
      field: 'platform',
      from_status: 'PAID',
      to_status: 'RECEIVED',
      event: 'P4',
      source: 'sync',
      at: '2026-10-07T03:00:01.000Z',
    },
  ]);
  const d = await detail(await s.get({}, o.order_id));
  expect(d.status_history).toEqual([
    {
      field: 'platform',
      from: null,
      to: 'PAID',
      event: 'P2',
      source: 'sync',
      at: '2026-10-06T02:58:40.000Z',
    },
    {
      field: 'rebate',
      from: 'UNATTRIBUTED',
      to: 'ESTIMATED',
      event: 'R1',
      source: 'admin',
      at: '2026-10-06T03:00:00.000Z',
    },
    {
      field: 'rebate',
      from: 'ESTIMATED',
      to: 'WAITING',
      event: 'R3',
      source: 'system',
      at: '2026-10-07T03:00:00.000Z',
    },
    {
      field: 'platform',
      from: 'PAID',
      to: 'RECEIVED',
      event: 'P4',
      source: 'sync',
      at: '2026-10-07T03:00:01.000Z',
    },
  ]);
});

it('[AC-B1-10i#34] commission_split 照快照输出金额（分）与比例（基点），受益人只含四项；未生成为 null', async () => {
  const s = await setup(h);
  const o = await order(s, { buy_type: 'share' });
  const without = await order(s);
  const [sharer, direct, indirect] = [randomUUID(), randomUUID(), randomUUID()];
  const rule = await split(
    s,
    o.order_id,
    [
      {
        user_id: sharer,
        role: 'share',
        ratio_bp: 5000,
        level: 'L1',
        initial_status: 'active',
        forfeit_reason: null,
      },
      {
        user_id: direct,
        role: 'direct',
        ratio_bp: 1000,
        level: 'L2',
        initial_status: 'active',
        forfeit_reason: 'banned',
      },
      {
        user_id: indirect,
        role: 'indirect',
        ratio_bp: 500,
        level: 'L3',
        initial_status: 'active',
        forfeit_reason: null,
      },
    ],
    { order_type: 'share' },
  );
  expect((await detail(await s.get({}, o.order_id))).commission_split).toEqual({
    rule_version_id: rule,
    order_type: 'share',
    raw_n_fen: 1000,
    subsidy_commission_fen: 20,
    reserve_bp: 1500,
    reserve_fen: 150,
    tlj_deduct_fen: 30,
    base_fen: 840,
    platform_retain_fen: 298,
    beneficiaries: [
      { user_id: sharer, role: 'share', ratio_bp: 5000, forfeit_reason: null },
      { user_id: direct, role: 'direct', ratio_bp: 1000, forfeit_reason: 'banned' },
      { user_id: indirect, role: 'indirect', ratio_bp: 500, forfeit_reason: null },
    ],
    created_at: SPLIT_AT,
  });
  expect((await detail(await s.get({}, without.order_id))).commission_split).toBeNull();
});

it('[AC-B1-10i#35] link_logs 取本订单 link_id 的最新 50 条，新的在前，只含时间、事件、场景', async () => {
  const s = await setup(h);
  const linkId = randomUUID();
  const o = await order(s, { link_id: linkId });
  const bare = await order(s, { link_id: null });
  const events = ['convert', 'precompute', 'register', 'open'] as const;
  const scenes = ['search', 'detail', 'feed', 'share'] as const;
  const moment = (n: number) => `2026-10-05T00:${String(n).padStart(2, '0')}:00.000Z`;
  await linkLogs(
    s,
    linkId,
    Array.from({ length: 52 }, (_, n) => ({
      created_at: moment(n),
      event: events[n % 4]!,
      scene: scenes[n % 4]!,
    })),
  );
  await linkLogs(s, randomUUID(), [{ created_at: '2026-10-06T00:00:00.000Z', scene: 'agent' }]);
  await h.db
    .insertInto('link_logs')
    .values({
      app_id: `${s.appId}_other`,
      link_id: linkId,
      event: 'open',
      result_code: 0,
      scene: 'push',
      created_at: '2026-10-06T00:00:00.000Z',
    })
    .execute();
  const d = await detail(await s.get({}, o.order_id));
  expect(d.link_logs).toEqual(
    Array.from({ length: 50 }, (_, i) => 51 - i).map((n) => ({
      at: moment(n),
      event: events[n % 4],
      scene: scenes[n % 4],
    })),
  );
  expect((await detail(await s.get({}, bare.order_id))).link_logs).toEqual([]);
});
