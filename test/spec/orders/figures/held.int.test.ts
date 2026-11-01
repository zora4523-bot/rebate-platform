// B1-09p · viewer_share_held（BR-FUND-17「查看者本人份额暂缓」，BR-CALC-13，BR-FUND-04 ⑫）：
// 订单已 CREDITED 而本人的 first_credit / reassign_credit 义务 open 时按 REVIEWING 展示。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { credited, fixture, useDatabase } from './kit.ts';

const pg = useDatabase(createTestDatabase);

it.each([{ kind: 'first_credit' }, { kind: 'reassign_credit' }] as const)(
  '[AC-B1-09p#38][BR-FUND-17][BR-TEXT-02] 本人 $kind 义务 open：REVIEWING，预估返本人份额，不给实返，列表详情一致',
  async ({ kind }) => {
    const f = await fixture(pg.db);
    const o = await f.order({ patch: credited() });
    await f.obligation(o, { kind });
    expect(await f.detail(o)).toMatchObject({
      display_status: 'REVIEWING',
      est_rebate_fen: 425,
      actual_fen: null,
    });
    expect(await f.row(o)).toMatchObject({ display_status: 'REVIEWING', est_rebate_fen: 425 });
  },
  60_000,
);

it('[AC-B1-09p#39][BR-FUND-17][BR-TEXT-02] 分享单本人 first_credit 义务 open：同样 REVIEWING，预估返 share 份额', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({
    patch: credited({ buy_type: 'share' }),
    people: [{ userId: f.subject.user_id, role: 'share', ratioBp: 4000 }],
  });
  await f.obligation(o, { kind: 'first_credit', role: 'share' });
  expect(await f.detail(o)).toMatchObject({ display_status: 'REVIEWING', est_rebate_fen: 340 });
}, 60_000);

it('[AC-B1-09p#40][BR-FUND-17] deferred 义务 open 不算暂缓：已入账的份额照常已结算', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: credited() });
  await f.credit(o, { amount: 425n });
  await f.obligation(o, { kind: 'deferred' });
  expect(await f.detail(o)).toMatchObject({ display_status: 'CREDITED', actual_fen: 425 });
}, 60_000);

it('[AC-B1-09p#41][BR-FUND-17] 义务 done 后回到已结算，实返是补记的金额', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: credited() });
  const obligation = await f.obligation(o, { kind: 'first_credit' });
  expect(await f.detail(o)).toMatchObject({ display_status: 'REVIEWING' });
  const voucherId = await f.credit(o, { amount: 425n });
  await f.closeObligation(obligation, voucherId);
  expect(await f.detail(o)).toMatchObject({ display_status: 'CREDITED', actual_fen: 425 });
}, 60_000);

it('[AC-B1-09p#68][BR-FUND-17][BR-FUND-04] 义务以 forfeited 结案：不再是暂缓，回到已结算，实返 0', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: credited() });
  const obligation = await f.obligation(o, { kind: 'first_credit' });
  expect(await f.detail(o)).toMatchObject({ display_status: 'REVIEWING' });
  await f.forfeitObligation(obligation);
  expect(await f.detail(o)).toMatchObject({ display_status: 'CREDITED', actual_fen: 0 });
}, 60_000);

it('[AC-B1-09p#42][BR-FUND-17] 别的受益人暂缓不影响本人', async () => {
  const f = await fixture(pg.db);
  const parent = await f.user();
  const o = await f.order({
    patch: credited(),
    people: [
      { userId: f.subject.user_id, role: 'self', ratioBp: 5000 },
      { userId: parent, role: 'direct', ratioBp: 1000 },
    ],
  });
  await f.credit(o, { amount: 425n });
  await f.obligation(o, { kind: 'first_credit', userId: parent, role: 'direct' });
  expect(await f.detail(o)).toMatchObject({ display_status: 'CREDITED', actual_fen: 425 });
}, 60_000);

it('[AC-B1-09p#43][BR-FUND-17] 本人别的单的义务不串到这一单', async () => {
  const f = await fixture(pg.db);
  const held = await f.order({ patch: credited() });
  const clear = await f.order({ patch: credited() });
  await f.credit(clear, { amount: 425n });
  await f.obligation(held, { kind: 'first_credit' });
  expect(await f.row(held)).toMatchObject({ display_status: 'REVIEWING' });
  expect(await f.row(clear)).toMatchObject({ display_status: 'CREDITED' });
}, 60_000);
