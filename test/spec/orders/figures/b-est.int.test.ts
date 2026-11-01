// B1-09p · BR-FUND-17 派生表第 6、7 行与「B_est 为空」，BR-CALC-02 取值阶段：b_est 经用户接口的
// display_status 与 est_rebate_fen 读出。默认 N=1000、预留 15%：B=850，self 50% → 425。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { fixture, useDatabase, waiting, type OrderInput, type OrderPatch } from './kit.ts';

const pg = useDatabase(createTestDatabase);
const presale: OrderPatch = {
  platform_status: 'DEPOSIT_PAID',
  is_presale: true,
  deposit_paid_at: '2027-10-09T02:00:00.000Z',
  paid_at: null,
};
const noBase: readonly { readonly label: string; readonly input: OrderInput }[] = [
  { label: '预估佣金为 0', input: { patch: { est_commission_fen: 0n } } },
  { label: '预估佣金为负', input: { patch: { est_commission_fen: -500n } } },
  { label: '淘礼金扣完基数', input: { tljDeductFen: 850n } },
  { label: '预留 100%', input: { reserveBp: 10000 } },
  { label: 'WAITING 且预估佣金为 0', input: { patch: waiting({ est_commission_fen: 0n }) } },
];

it.each([
  { label: 'ESTIMATED', patch: {}, display_status: 'PAID' },
  { label: 'WAITING', patch: waiting(), display_status: 'WAITING' },
])(
  '[AC-B1-09p#1][BR-FUND-17] 无分佣快照的 $label 单：b_est 未知，不算本单无返利，不显示金额',
  async ({ patch, display_status }) => {
    const f = await fixture(pg.db);
    const o = await f.bareOrder(patch);
    expect(await f.detail(o)).toMatchObject({ display_status, est_rebate_fen: null });
    expect(await f.row(o)).toMatchObject({ display_status, est_rebate_fen: null });
  },
  60_000,
);

it.each([
  { label: 'ESTIMATED', patch: {}, display_status: 'PAID' },
  { label: 'WAITING', patch: waiting(), display_status: 'WAITING' },
  { label: '付定金', patch: presale, display_status: 'DEPOSIT_PAID' },
])(
  '[AC-B1-09p#2][BR-FUND-17] 有快照但预估与结算佣金全空的 $label 单：b_est 为 null，不匹配第 7 行',
  async ({ patch, display_status }) => {
    const f = await fixture(pg.db);
    const o = await f.order({
      patch: { ...patch, est_commission_fen: null, settle_commission_fen: null },
    });
    expect(await f.detail(o)).toMatchObject({ display_status, est_rebate_fen: null });
  },
  60_000,
);

it.each(noBase)(
  '[AC-B1-09p#3][BR-FUND-17][BR-CALC-02] $label：B_est=0 → NO_REBATE，不显示金额',
  async ({ input }) => {
    const f = await fixture(pg.db);
    const o = await f.order(input);
    expect(await f.detail(o)).toMatchObject({ display_status: 'NO_REBATE', est_rebate_fen: null });
  },
  60_000,
);

it('[AC-B1-09p#4][BR-CALC-02] 结算佣金优先于预估：按结算额算份额，预估变化只存档', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({
    patch: waiting({ est_commission_fen: 5000n, settle_commission_fen: 1000n }),
  });
  expect(await f.detail(o)).toMatchObject({ display_status: 'WAITING', est_rebate_fen: 425 });
}, 60_000);

it('[AC-B1-09p#5][BR-CALC-02] 预估为 0 而结算佣金为正：有效佣金非 0，不是 NO_REBATE', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({
    patch: waiting({ est_commission_fen: 0n, settle_commission_fen: 1000n }),
  });
  expect(await f.detail(o)).toMatchObject({ display_status: 'WAITING', est_rebate_fen: 425 });
}, 60_000);

it('[AC-B1-09p#6][BR-CALC-02] 预估为正而结算佣金为 0：取结算额，B_est=0 → NO_REBATE', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({
    patch: waiting({ est_commission_fen: 1000n, settle_commission_fen: 0n }),
  });
  expect(await f.detail(o)).toMatchObject({ display_status: 'NO_REBATE', est_rebate_fen: null });
}, 60_000);

it.each([
  { label: 'B_est=0', est_commission_fen: 0n },
  { label: 'B_est 为空', est_commission_fen: null },
  { label: 'B_est>0', est_commission_fen: 1000n },
])(
  '[AC-B1-09p#7][BR-FUND-17] 付定金阶段 $label：第 6 行先于第 7 行，显示已付定金且不显示金额',
  async ({ est_commission_fen }) => {
    const f = await fixture(pg.db);
    const o = await f.order({ patch: { ...presale, est_commission_fen } });
    expect(await f.detail(o)).toMatchObject({
      display_status: 'DEPOSIT_PAID',
      est_rebate_fen: null,
    });
  },
  60_000,
);
