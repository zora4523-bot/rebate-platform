// B1-09p · BR-FUND-04 ⑪ 的每个分支（expected_credit_period、credit_overdue）与它们驱动的
// BR-FUND-17 第 8、9、10、12、13 行。时刻只来自注入的 Clock（f.clock），配置读真实 config_items。
// 默认 settle_period=2027-11、偏移 1 → 2027-12；账单日 24 + 宽限 10 → 2028-01-03（+08:00）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  EXPECTED,
  PAID_MONTH,
  credited,
  fixture,
  useDatabase,
  waiting,
  type OrderPatch,
} from './kit.ts';

const pg = useDatabase(createTestDatabase);
const DEADLINE_LAST_MS = '2028-01-03T15:59:59.999Z';
const DEADLINE_NEXT_DAY = '2028-01-03T16:00:00.000Z';
const paused: readonly {
  readonly label: string;
  readonly patch: OrderPatch;
  readonly display_status: string;
}[] = [
  { label: 'hold', patch: { hold: true }, display_status: 'REVIEWING' },
  { label: '维权中', patch: { rights_pending: true }, display_status: 'RIGHTS_PENDING' },
];

it('[AC-B1-09p#17][BR-FUND-04] 未有联盟结算时间：确认收货月 + 默认 1 个月', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: waiting() });
  const detail = await f.detail(o);
  expect(detail).toMatchObject({
    display_status: 'WAITING',
    est_rebate_fen: 425,
    expected_credit_period: EXPECTED,
    credit_overdue: false,
  });
  expect(detail?.timeline.find((item) => item.node === 'credit_expected')?.period).toBe(EXPECTED);
}, 60_000);

it('[AC-B1-09p#18][BR-FUND-04] 跨年：2027-12 确认收货 → 2028-01', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: waiting({ settle_period: '2027-12' }) });
  expect(await f.detail(o)).toMatchObject({ expected_credit_period: '2028-01' });
}, 60_000);

it('[AC-B1-09p#19][BR-FUND-04] settle.period_offset_months.<platform> 按单所在平台取值', async () => {
  const f = await fixture(pg.db, { config: { 'settle.period_offset_months.pdd': 2 } });
  const pdd = await f.order({ patch: waiting({ platform: 'pdd' }) });
  const jd = await f.order({ patch: waiting({ platform: 'jd' }) });
  expect(await f.detail(pdd)).toMatchObject({ expected_credit_period: '2028-01' });
  expect(await f.detail(jd)).toMatchObject({ expected_credit_period: EXPECTED });
}, 60_000);

it.each([
  { label: '+08:00 月初第一刻', at: '2027-09-30T16:00:00.000Z', period: '2027-10' },
  { label: '+08:00 月末最后一刻', at: '2027-09-30T15:59:59.999Z', period: '2027-09' },
])(
  '[AC-B1-09p#20][BR-FUND-04] 已有 union_settled_at（$label）：取其所在自然月，以联盟为准',
  async ({ at, period }) => {
    const f = await fixture(pg.db);
    const o = await f.order({ patch: waiting({ union_settled_at: at }) });
    expect(await f.detail(o)).toMatchObject({ expected_credit_period: period });
  },
  60_000,
);

it.each(paused)(
  '[AC-B1-09p#21][BR-FUND-04] $label：月份 null、不逾期，金额照常',
  async ({ patch, display_status }) => {
    const f = await fixture(pg.db, { now: DEADLINE_NEXT_DAY });
    const o = await f.order({ patch: waiting(patch) });
    expect(await f.detail(o)).toMatchObject({
      display_status,
      est_rebate_fen: 425,
      expected_credit_period: null,
      credit_overdue: false,
    });
  },
  60_000,
);

it('[AC-B1-09p#22][BR-FUND-04] credit.enabled=off：月份 null、不逾期，显示 CREDITING', async () => {
  const f = await fixture(pg.db, {
    now: DEADLINE_NEXT_DAY,
    config: { 'credit.enabled.jd': false },
  });
  const o = await f.order({ patch: waiting() });
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CREDITING',
    est_rebate_fen: 425,
    expected_credit_period: null,
    credit_overdue: false,
  });
}, 60_000);

it.each([
  { label: 'ESTIMATED', patch: {} },
  { label: 'CREDITED', patch: credited() },
])(
  '[AC-B1-09p#23][BR-FUND-04] 非 WAITING 的 $label 单：月份 null、不逾期',
  async ({ patch }) => {
    const f = await fixture(pg.db, { now: DEADLINE_NEXT_DAY });
    const o = await f.order({ patch });
    expect(await f.detail(o)).toMatchObject({
      expected_credit_period: null,
      credit_overdue: false,
    });
  },
  60_000,
);

it('[AC-B1-09p#24][BR-FUND-04] 账单日 + 宽限恰好当天不逾期，次日逾期且月份保留，只走注入 Clock', async () => {
  const f = await fixture(pg.db, { now: DEADLINE_LAST_MS });
  const o = await f.order({ patch: waiting() });
  expect(await f.detail(o)).toMatchObject({
    display_status: 'WAITING',
    expected_credit_period: EXPECTED,
    credit_overdue: false,
  });
  f.clock.set(DEADLINE_NEXT_DAY);
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CREDITING',
    est_rebate_fen: 425,
    expected_credit_period: EXPECTED,
    credit_overdue: true,
  });
}, 60_000);

it('[AC-B1-09p#25][BR-FUND-04] settle.bill_day 与 settle.statement.grace_days 读配置：22 + 5 → 12-27', async () => {
  const f = await fixture(pg.db, {
    now: '2027-12-27T15:59:59.999Z',
    config: { 'settle.bill_day': 22, 'settle.statement.grace_days': 5 },
  });
  const o = await f.order({ patch: waiting() });
  expect(await f.detail(o)).toMatchObject({ credit_overdue: false });
  f.clock.set('2027-12-27T16:00:00.000Z');
  expect(await f.detail(o)).toMatchObject({ display_status: 'CREDITING', credit_overdue: true });
}, 60_000);

it('[AC-B1-09p#26][BR-FUND-04] 已有 union_settled_at 时逾期按其所在月的账单日算', async () => {
  // 2027-09 + 24 + 10 → 2027-10-04, long before the settle_period's month would say.
  const f = await fixture(pg.db, { now: '2027-10-04T16:00:00.000Z' });
  const o = await f.order({
    patch: waiting({ union_settled_at: '2027-09-15T04:00:00.000Z' }),
  });
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CREDITING',
    expected_credit_period: '2027-09',
    credit_overdue: true,
  });
}, 60_000);

it('[AC-B1-09p#27][BR-FUND-04] Agent 卡片的 expected_credit_period 与详情同值', async () => {
  const f = await fixture(pg.db);
  await f.order({ patch: waiting() });
  const found = await (await f.queries()).searchForAgent(f.subject, PAID_MONTH);
  expect(found.orders.map((item) => item.expected_credit_period)).toEqual([EXPECTED]);
}, 60_000);
