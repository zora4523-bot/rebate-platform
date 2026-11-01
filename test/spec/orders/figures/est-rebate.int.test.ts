// B1-09p · est_rebate_fen（BR-TEXT-02 金额字段、BR-CALC-02、BR-CALC-13）：查看者本人在该单的份额，
// 扣预留、淘礼金，分享单取 share 角色，同一用户的 direct / indirect 不计入；份额被剥夺给 0（D10-558 ④）。
// 与 GET /v1/wallet/summary 同单同数的比对在 production-api.int.test.ts。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { AT } from '../../settlement/pending-earnings/fixtures.ts';
import { fixture, useDatabase, waiting, PAID_MONTH } from './kit.ts';

const pg = useDatabase(createTestDatabase);

it('[AC-B1-09p#8][BR-CALC-02] 先扣预留再扣淘礼金：N=1000、预留 20%、淘礼金 30、比例 60% → 462', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({
    reserveBp: 2000,
    tljDeductFen: 30n,
    people: [{ userId: f.subject.user_id, role: 'self', ratioBp: 6000 }],
  });
  expect(await f.detail(o)).toMatchObject({ display_status: 'PAID', est_rebate_fen: 462 });
}, 60_000);

it('[AC-B1-09p#9][BR-CALC-02] 两次向下取整：N=333、预留 15%、比例 50% → 141', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: { est_commission_fen: 333n } });
  expect(await f.detail(o)).toMatchObject({ est_rebate_fen: 141 });
}, 60_000);

it('[AC-B1-09p#10][BR-CALC-02] 金额按订单当前佣金重算，不用快照建立时的份额', async () => {
  const f = await fixture(pg.db);
  // The snapshot was taken on N=1000; the order's estimate has moved since.
  const o = await f.order({ patch: { est_commission_fen: 2000n } });
  expect(await f.detail(o)).toMatchObject({ est_rebate_fen: 850 });
}, 60_000);

it('[AC-B1-09p#11][BR-TEXT-02] 分享单取 share 角色：列表与详情都是 40% → 340，不含直推', async () => {
  const f = await fixture(pg.db);
  const parent = await f.user();
  const o = await f.order({
    patch: { buy_type: 'share' },
    people: [
      { userId: f.subject.user_id, role: 'share', ratioBp: 4000 },
      { userId: parent, role: 'direct', ratioBp: 1000 },
    ],
  });
  expect(await f.detail(o)).toMatchObject({ display_status: 'PAID', est_rebate_fen: 340 });
  expect(await f.row(o, 'share')).toMatchObject({ est_rebate_fen: 340 });
}, 60_000);

it.each([
  { label: '自购单同时是直推', owner: 'self', extra: 'direct' },
  { label: '自购单同时是间推', owner: 'self', extra: 'indirect' },
  { label: '分享单同时是直推', owner: 'share', extra: 'direct' },
] as const)(
  '[AC-B1-09p#12][BR-TEXT-02] $label：同一用户的 direct / indirect 份额不计入',
  async ({ owner, extra }) => {
    const f = await fixture(pg.db);
    const o = await f.order({
      patch: { buy_type: owner },
      people: [
        { userId: f.subject.user_id, role: owner, ratioBp: 5000 },
        { userId: f.subject.user_id, role: extra, ratioBp: 1000 },
      ],
    });
    expect(await f.detail(o)).toMatchObject({ est_rebate_fen: 425 });
  },
  60_000,
);

it('[AC-B1-09p#13][BR-CALC-13][D10-558] 快照初始即被剥夺：份额 0 不是 null，仍是已付款而非本单无返利', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({
    people: [
      { userId: f.subject.user_id, role: 'self', ratioBp: 5000, initialStatus: 'forfeited' },
    ],
  });
  expect(await f.detail(o)).toMatchObject({ display_status: 'PAID', est_rebate_fen: 0 });
  expect(await f.row(o)).toMatchObject({ est_rebate_fen: 0 });
}, 60_000);

it('[AC-B1-09p#14][BR-CALC-13][D10-558] 快照后事件剥夺：列表、详情、Agent 列表都给 0', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({
    patch: waiting(),
    people: [
      {
        userId: f.subject.user_id,
        role: 'self',
        ratioBp: 5000,
        forfeitedEvent: { reason: 'banned', at: AT },
      },
    ],
  });
  expect(await f.detail(o)).toMatchObject({ display_status: 'WAITING', est_rebate_fen: 0 });
  expect(await f.row(o)).toMatchObject({ est_rebate_fen: 0 });
  const found = await (await f.queries()).searchForAgent(f.subject, PAID_MONTH);
  expect(found.orders.map((item) => item.est_rebate_fen)).toEqual([0]);
}, 60_000);

it('[AC-B1-09p#15][BR-CALC-13][D10-558] 别的受益人被剥夺不影响本人份额', async () => {
  const f = await fixture(pg.db);
  const parent = await f.user();
  const o = await f.order({
    people: [
      { userId: f.subject.user_id, role: 'self', ratioBp: 5000 },
      { userId: parent, role: 'direct', ratioBp: 1000, initialStatus: 'forfeited' },
    ],
  });
  expect(await f.detail(o)).toMatchObject({ est_rebate_fen: 425 });
}, 60_000);

it('[AC-B1-09p#16][BR-CALC-13][D10-558] 本人 self 份额被剥夺、direct 份额未剥夺：给 0，不把 direct 算进来', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({
    people: [
      {
        userId: f.subject.user_id,
        role: 'self',
        ratioBp: 5000,
        forfeitedEvent: { reason: 'banned', at: AT },
      },
      { userId: f.subject.user_id, role: 'direct', ratioBp: 1000 },
    ],
  });
  expect(await f.detail(o)).toMatchObject({ est_rebate_fen: 0 });
}, 60_000);
