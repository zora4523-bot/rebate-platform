// B1-15d GET /v1/me/deletion (08 BR-ID-27; contract getDeletion: the latest request, data null
// when there has never been one; can_cancel = cooling and now before cooling_until; brief §9.2 #5:
// latest by apply_at DESC, status read as stored and never rewritten by the read).
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  COOLING_MS,
  deletion,
  deletionData,
  ms,
  openFixture,
  requests,
  seedRequest,
  user,
  type CancelReason,
  type Fixture,
  type RequestStatus,
} from './kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

it('[AC-B1-15d#26] 无单 → data 为 null', async () => {
  const u = await user(f);
  expect(await deletionData(await u.get())).toBeNull();
});

it('[AC-B1-15d#27] cooling 截止前 can_cancel=true；截止时刻起 can_cancel=false，状态仍 cooling、库不改', async () => {
  const before = await user(f);
  const now = f.clock.now().getTime();
  const applied = new Date(now - COOLING_MS + 1);
  await seedRequest(f, before.appId, before.uid, 'cooling', applied);
  const open = await deletion(await before.get());
  expect(open).toEqual({
    status: 'cooling',
    apply_at: open.apply_at,
    cooling_until: open.cooling_until,
    can_cancel: true,
    cancelled_at: null,
    cancel_reason: null,
    processed_at: null,
  });
  expect(ms(open.apply_at)).toBe(applied.getTime());
  expect(ms(open.cooling_until)).toBe(now + 1);

  const at = await user(f);
  await seedRequest(f, at.appId, at.uid, 'cooling', new Date(now - COOLING_MS));
  const expired = await deletion(await at.get());
  expect(expired).toMatchObject({ status: 'cooling', can_cancel: false });
  expect((await requests(f, at.appId, at.uid))[0]).toMatchObject({
    status: 'cooling',
    row_version: 0,
  });
});

const STAGES: readonly [RequestStatus, CancelReason | null][] = [
  ['cancelled', 'user'],
  ['cancelled', 'negative_balance'],
  ['processing', null],
  ['done', null],
];

it.each(STAGES)('[AC-B1-15d#28] %s（%s）阶段如实返回，can_cancel=false', async (status, reason) => {
  const u = await user(f);
  const applied = new Date(f.clock.now().getTime() - COOLING_MS - 7_200_000);
  const until = applied.getTime() + COOLING_MS;
  await seedRequest(
    f,
    u.appId,
    u.uid,
    status,
    applied,
    reason === null ? {} : { cancelReason: reason },
  );
  const data = await deletion(await u.get());
  expect(data).toMatchObject({ status, can_cancel: false, cancel_reason: reason });
  expect(ms(data.apply_at)).toBe(applied.getTime());
  expect(ms(data.cooling_until)).toBe(until);
  expect(ms(data.processed_at)).toBe(status === 'done' ? until : null);
  const cancelledAt =
    reason === 'user' ? applied.getTime() : reason === 'negative_balance' ? until : null;
  expect(ms(data.cancelled_at)).toBe(cancelledAt);
});

it('[AC-B1-15d#29] 多张历史取最新（apply_at 最晚）', async () => {
  const u = await user(f);
  const now = f.clock.now().getTime();
  await seedRequest(f, u.appId, u.uid, 'cancelled', new Date(now - 20 * 86_400_000));
  const latest = new Date(now - 2 * 86_400_000);
  await seedRequest(f, u.appId, u.uid, 'cooling', latest);
  await seedRequest(f, u.appId, u.uid, 'cancelled', new Date(now - 10 * 86_400_000));
  const data = await deletion(await u.get());
  expect(data).toMatchObject({ status: 'cooling', can_cancel: true });
  expect(ms(data.apply_at)).toBe(latest.getTime());
});

it('[AC-B1-15d#30] 申请 → 撤回 → 再申请后，GET 返回最新的 cooling 单', async () => {
  const u = await user(f);
  await deletion(await u.apply({ stepUp: await u.mint() }));
  await deletion(await u.cancel());
  expect((await deletion(await u.get())).status).toBe('cancelled');
  f.clock.advanceMs(60_000);
  const again = await deletion(await u.apply({ stepUp: await u.mint() }));
  expect(again.status).toBe('cooling');
  expect(await deletion(await u.get())).toEqual(again);
  expect(await requests(f, u.appId, u.uid)).toHaveLength(2);
});
