// B1-09p · appeal_pending（BR-ID-36）：只看该单 processing 的订单申诉；已结案、账户申诉不算，
// 跨 App 不串。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { fixture, useDatabase } from './kit.ts';

const pg = useDatabase(createTestDatabase);

it('[AC-B1-09p#44][BR-ID-36] processing 的订单申诉：appeal_pending 为真，只落在被申诉的那一单', async () => {
  const f = await fixture(pg.db);
  const appealed = await f.order();
  const other = await f.order();
  await f.appeal(appealed);
  expect(await f.detail(appealed)).toMatchObject({ appeal_pending: true });
  expect(await f.detail(other)).toMatchObject({ appeal_pending: false });
}, 60_000);

it.each([{ status: 'upheld' }, { status: 'revoked' }] as const)(
  '[AC-B1-09p#45][BR-ID-36] 已结案（$status）：appeal_pending 为假',
  async ({ status }) => {
    const f = await fixture(pg.db);
    const o = await f.order();
    await f.appeal(o, { status });
    expect(await f.detail(o)).toMatchObject({ appeal_pending: false });
  },
  60_000,
);

it('[AC-B1-09p#46][BR-ID-36] 结案后再次申诉：有一条 processing 就为真', async () => {
  const f = await fixture(pg.db);
  const o = await f.order();
  await f.appeal(o, { status: 'upheld' });
  await f.appeal(o);
  expect(await f.detail(o)).toMatchObject({ appeal_pending: true });
}, 60_000);

it('[AC-B1-09p#47][BR-ID-36] 账户申诉不算', async () => {
  const f = await fixture(pg.db);
  const o = await f.order();
  await f.appeal(o, { targetType: 'account' });
  expect(await f.detail(o)).toMatchObject({ appeal_pending: false });
}, 60_000);

it('[AC-B1-09p#48][BR-ID-36] 别的 App 里 target_id 相同的订单申诉不串', async () => {
  const f = await fixture(pg.db);
  const foreign = await fixture(pg.db);
  const o = await f.order();
  const own = await foreign.order();
  await foreign.appeal(own, { targetId: o.orderId });
  expect(await f.detail(o)).toMatchObject({ appeal_pending: false });
}, 60_000);
