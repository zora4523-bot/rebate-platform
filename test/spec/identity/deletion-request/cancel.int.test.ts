// B1-15d POST /v1/me/deletion/cancel (08 BR-ID-27: withdrawal allowed while now < apply_at +
// 7×24 h, judged by time and not by whether the scheduled job ran; later → 10007; brief §9.2 #4 and
// ruling §9.2 #12: past the cutoff 10007 data.stage=processing, never applied → data null; the
// contract: repeating a successful cancel returns the cancelled request).
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  COOLING_MS,
  deletion,
  deletionData,
  failed,
  ms,
  openFixture,
  requests,
  seedRequest,
  user,
  type Fixture,
} from './kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

it('[AC-B1-15d#19] 申请后立即撤回：cancelled、cancel_reason=user、cancelled_at=now、can_cancel=false', async () => {
  const u = await user(f);
  const applied = await deletion(await u.apply({ stepUp: await u.mint() }));
  f.clock.advanceMs(3_000);
  const now = f.clock.now().getTime();
  const data = await deletion(await u.cancel());
  expect(data).toMatchObject({
    status: 'cancelled',
    can_cancel: false,
    cancel_reason: 'user',
    processed_at: null,
  });
  expect(ms(data.cancelled_at)).toBe(now);
  expect(data.apply_at).toBe(applied.apply_at);
  expect(data.cooling_until).toBe(applied.cooling_until);
  const rows = await requests(f, u.appId, u.uid);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'user', row_version: 1 });
  expect(rows[0]!.cancelled_at!.getTime()).toBe(now);
  expect(rows[0]!.updated_at.getTime()).toBe(now);
});

it('[AC-B1-15d#20] cooling_until 前 1 ms 撤回成功', async () => {
  const u = await user(f);
  const now = f.clock.now().getTime();
  await seedRequest(f, u.appId, u.uid, 'cooling', new Date(now - COOLING_MS + 1));
  const data = await deletion(await u.cancel());
  expect(data).toMatchObject({ status: 'cancelled', cancel_reason: 'user', can_cancel: false });
  expect(ms(data.cancelled_at)).toBe(now);
  expect(ms(data.cooling_until)).toBe(now + 1);
});

it.each([
  ['恰好 cooling_until', 0],
  ['cooling_until 之后 1 ms', 1],
  ['cooling_until 之后 1 天', 86_400_000],
] as const)(
  '[AC-B1-15d#21] %s 撤回 → 10007 stage=processing，单仍是 cooling（定时任务未跑）',
  async (_name, past) => {
    const u = await user(f);
    const now = f.clock.now().getTime();
    await seedRequest(f, u.appId, u.uid, 'cooling', new Date(now - COOLING_MS - past));
    const body = await failed(await u.cancel(), 403, 10007);
    expect(body['data']).toEqual({ stage: 'processing' });
    const rows = await requests(f, u.appId, u.uid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'cooling',
      cancelled_at: null,
      cancel_reason: null,
      row_version: 0,
    });
  },
);

it.each(['processing', 'done'] as const)(
  '[AC-B1-15d#22] 最新单为 %s 时撤回 → 10007 stage=processing，单不变',
  async (status) => {
    const u = await user(f);
    const applied = new Date(f.clock.now().getTime() - COOLING_MS - 60_000);
    await seedRequest(f, u.appId, u.uid, status, applied);
    const body = await failed(await u.cancel(), 403, 10007);
    expect(body['data']).toEqual({ stage: 'processing' });
    const rows = await requests(f, u.appId, u.uid);
    expect(rows.map((row) => [row.status, row.row_version])).toEqual([[status, 0]]);
  },
);

it('[AC-B1-15d#23] 重复撤回返回已撤回单（cancelled_at 不变、不再更新）', async () => {
  const u = await user(f);
  await deletion(await u.apply({ stepUp: await u.mint() }));
  const first = await deletion(await u.cancel());
  f.clock.advanceMs(1_000);
  const again = await deletion(await u.cancel());
  expect(again).toEqual(first);
  const rows = await requests(f, u.appId, u.uid);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.row_version).toBe(1);
});

it('[AC-B1-15d#24] 最新单为 negative_balance 撤销的单 → 原样返回', async () => {
  const u = await user(f);
  const applied = new Date(f.clock.now().getTime() - COOLING_MS - 3_600_000);
  await seedRequest(f, u.appId, u.uid, 'cancelled', applied, { cancelReason: 'negative_balance' });
  const data = await deletion(await u.cancel());
  expect(data).toMatchObject({
    status: 'cancelled',
    cancel_reason: 'negative_balance',
    can_cancel: false,
  });
  expect(ms(data.cancelled_at)).toBe(applied.getTime() + COOLING_MS);
  expect((await requests(f, u.appId, u.uid))[0]!.row_version).toBe(0);
});

it('[AC-B1-15d#25] 从未申请时撤回 → 200、data 为 null，不建单', async () => {
  const u = await user(f);
  expect(await deletionData(await u.cancel())).toBeNull();
  expect(await requests(f, u.appId, u.uid)).toEqual([]);
});
