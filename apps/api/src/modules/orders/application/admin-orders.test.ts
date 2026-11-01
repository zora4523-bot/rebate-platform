import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { AdminOrderDetailRow, AdminOrderReads } from '../infra/admin-order-reads.ts';
import {
  AdminOrders,
  AdminOrdersFieldsError,
  type AdminOrderPorts,
  type AdminOrderSplitRecord,
} from './admin-orders.ts';
import { createUnknownOrderFigures, type OrderFigures } from './order-queries.ts';

const APP = 'app_unit';
const ORDER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
const at = (iso: string) => new FixedClock(iso).now();

function row(patch: Partial<AdminOrderDetailRow> = {}): AdminOrderDetailRow {
  return {
    order_id: ORDER,
    sub_order_id: 'SUB-1',
    parent_order_id: 'PARENT-1',
    platform: 'jd',
    title: null,
    image_url: null,
    user_id: USER,
    paid_at: at('2026-10-06T02:58:40.000Z'),
    pay_amount_fen: 3990n,
    est_commission_fen: 500n,
    settle_commission_fen: null,
    platform_status: 'PAID',
    rebate_status: 'ESTIMATED',
    hold: false,
    hold_reason: null,
    locked: false,
    rights_pending: false,
    raw_item_id: 'item',
    product_key: null,
    quantity: 1,
    refunded_quantity: 0,
    reason: null,
    buy_type: 'self',
    scene_basis: 'param',
    user_basis: 'param',
    is_presale: false,
    deposit_paid_at: null,
    received_at: null,
    settled_at: null,
    credited_at: null,
    settle_period: null,
    commission_rate_bp: null,
    row_version: 0,
    link_id: null,
    booked_base_fen: null,
    ...patch,
  };
}

function service(
  detail: AdminOrderDetailRow | undefined,
  ports: Partial<AdminOrderPorts> = {},
  calls: string[] = [],
) {
  const reads: AdminOrderReads = {
    count: () => {
      calls.push('count');
      return Promise.resolve(detail === undefined ? 0 : 1);
    },
    page: () => {
      calls.push('page');
      return Promise.resolve(detail === undefined ? [] : [detail]);
    },
    order: () => Promise.resolve(detail),
    history: () => Promise.resolve([]),
    pending: () => {
      calls.push('pending');
      return Promise.resolve([{ reason: 'UNMAPPED_STATUS', status: 'open' }]);
    },
  };
  return new AdminOrders({
    reads,
    phones: (_app, ids) => Promise.resolve(new Map(ids.map((id) => [id, '138****5678']))),
    adminNames: (_app, ids) => {
      calls.push('names');
      return Promise.resolve(new Map(ids.map((id) => [id, '客服小林'])));
    },
    latestHold: () =>
      Promise.resolve({ admin_id: ADMIN, note: '暂停核实', at: at('2026-10-07T01:00:00.000Z') }),
    commissionSplit: () => Promise.resolve(null),
    linkLogs: () => Promise.resolve([]),
    creditEnabled: () => Promise.resolve(true),
    figures: createUnknownOrderFigures(),
    ...ports,
  });
}

async function refused(promise: Promise<unknown>): Promise<readonly string[]> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AdminOrdersFieldsError);
  return (error as AdminOrdersFieldsError).fields;
}

it('[AC-B1-10i#U1] q 与支付区间不合法先于读库报 20001', async () => {
  const calls: string[] = [];
  const orders = service(row(), {}, calls);
  expect(await refused(orders.list(APP, { q: '   ' }))).toEqual(['q']);
  expect(
    await refused(
      orders.list(APP, {
        paid_from: '2026-10-07T00:00:00+08:00',
        paid_to: '2026-10-06T00:00:00+08:00',
      }),
    ),
  ).toEqual(['paid_from', 'paid_to']);
  expect(calls).toEqual([]);
});

it('[AC-B1-10i#U2] 非 UUID 的 user_id 不读库直接空页；越过末页不读行', async () => {
  const calls: string[] = [];
  const orders = service(row(), {}, calls);
  expect(await orders.list(APP, { user_id: 'nobody', page: 2, page_size: 5 })).toEqual({
    items: [],
    page: 2,
    page_size: 5,
    total: 0,
  });
  expect(calls).toEqual([]);
  expect((await orders.list(APP, { page: 2, page_size: 5 })).items).toEqual([]);
  expect(calls).toEqual(['count']);
});

it('[AC-B1-10i#U3] 列表行脱敏手机号、金额整数分，hold 为假时不显示 hold_reason', async () => {
  const orders = service(row({ hold: false, hold_reason: 'CS' }));
  const page = await orders.list(APP, {});
  expect(page.items[0]).toMatchObject({
    user: { user_id: USER, phone_masked: '138****5678' },
    pay_amount_fen: 3990,
    hold_reason: null,
    paid_at: '2026-10-06T02:58:40.000Z',
  });
});

it('[AC-B1-10i#U4] 详情：非 UUID、他人订单与未归因订单（带 user_id）都报 order_id', async () => {
  expect(await refused(service(row()).detail(APP, 'x', undefined))).toEqual(['order_id']);
  expect(await refused(service(undefined).detail(APP, ORDER, undefined))).toEqual(['order_id']);
  const other = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02';
  expect(await refused(service(row()).detail(APP, ORDER, other))).toEqual(['order_id']);
  expect(await refused(service(row({ user_id: null })).detail(APP, ORDER, USER))).toEqual([
    'order_id',
  ]);
});

it('[AC-B1-10i#U5] 系统 UNMAPPED_STATUS 暂停：读待处理记录、不查操作人名字、last_hold_* 为空', async () => {
  const calls: string[] = [];
  const d = await service(row({ hold: true, hold_reason: 'UNMAPPED_STATUS' }), {}, calls).detail(
    APP,
    ORDER,
    undefined,
  );
  expect(d).toMatchObject({ unmapped_pending_open: true, last_hold_by: null });
  expect(calls).toEqual(['pending']);
});

it('[AC-B1-10i#U6] 人工暂停取审计与名字；快照受益人只留四项，库内超出契约的值报错', async () => {
  const split: AdminOrderSplitRecord = {
    rule_version_id: ADMIN,
    order_type: 'self',
    raw_n_fen: 1000n,
    subsidy_commission_fen: 0n,
    reserve_bp: 1500,
    reserve_fen: 150n,
    tlj_deduct_fen: 0n,
    base_fen: 850n,
    platform_retain_fen: 300n,
    beneficiaries: [{ user_id: USER, role: 'self', ratio_bp: 6000, level: 'L1' }],
    created_at: at('2026-10-06T03:00:00.000Z'),
  };
  const d = await service(row({ hold: true, hold_reason: 'CS' }), {
    commissionSplit: () => Promise.resolve(split),
  }).detail(APP, ORDER, USER);
  expect(d).toMatchObject({
    last_hold_by: ADMIN,
    last_hold_by_name: '客服小林',
    last_hold_note: '暂停核实',
    last_hold_at: '2026-10-07T01:00:00.000Z',
    display_status: 'REVIEWING',
    unmapped_pending_open: false,
  });
  expect(d.commission_split?.beneficiaries).toEqual([
    { user_id: USER, role: 'self', ratio_bp: 6000, forfeit_reason: null },
  ]);
  const broken = service(row(), {
    commissionSplit: () =>
      Promise.resolve({ ...split, beneficiaries: [{ user_id: USER, role: 'boss', ratio_bp: 1 }] }),
  });
  await expect(broken.detail(APP, ORDER, undefined)).rejects.toThrow(/outside the contract/);
});

it('[AC-B1-10i#U7] 链接记录只下发时间、事件、场景，无场景的记录不下发', async () => {
  const d = await service(row({ link_id: ADMIN }), {
    linkLogs: () =>
      Promise.resolve([
        { at: at('2026-10-05T02:00:00.000Z'), event: 'open', scene: 'detail' },
        { at: at('2026-10-05T01:00:00.000Z'), event: 'convert', scene: null },
      ]),
  }).detail(APP, ORDER, undefined);
  expect(d.link_logs).toEqual([{ at: '2026-10-05T02:00:00.000Z', event: 'open', scene: 'detail' }]);
});

it('[AC-B1-09p#U3] 详情的 display_status 用所有者的数据；无所有者的单不读', async () => {
  const seen: string[] = [];
  const figures = {
    forOrders: (subject: { user_id: string }, ids: readonly string[]) => {
      seen.push(subject.user_id);
      const value: OrderFigures = {
        b_est: 850n,
        est_rebate_fen: 425n,
        actual_fen: 325n,
        clawback_fen: 100n,
        has_clawback: true,
        part_clawed_at: null,
        viewer_share_held: false,
        expected_credit_period: null,
        credit_overdue: false,
        appeal_pending: false,
      };
      return Promise.resolve(new Map(ids.map((id) => [id, value])));
    },
  };
  const credited = row({ rebate_status: 'CREDITED', booked_base_fen: 850n });
  const detail = await service(credited, { figures }).detail(APP, ORDER, undefined);
  expect(detail.display_status).toBe('CREDITED_PART_CLAWED');
  expect(seen).toEqual([USER]);
  seen.length = 0;
  const ownerless = row({ user_id: null, rebate_status: 'UNATTRIBUTED' });
  await service(ownerless, { figures }).detail(APP, ORDER, undefined);
  expect(seen).toEqual([]);
});
