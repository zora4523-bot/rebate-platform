// B1-15d POST /v1/me/deletion business judgement (08 BR-ID-27; brief §9.2 #3, ruling D10-97):
// in-flight withdrawal → 30412 through the WithdrawalInFlightReader port, negative balance → 30416
// with data.amount_fen through the ledger-backed balance port, 30412 before 30416, an open request
// returned as it is, and the inserted cooling row (apply_at + 7×24 h from the injected Clock,
// balance snapshot). Both ports are read on the caller's transaction while the user's row is locked.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  COOLING_MS,
  balanceCallsOf,
  deletion,
  failed,
  inFlightCallsOf,
  ms,
  openFixture,
  requests,
  seedBalance,
  seedRequest,
  setInFlight,
  stepUpRequired,
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

it('[AC-B1-15d#1] 申请成功：cooling，cooling_until = apply_at + 7×24h（注入时钟），can_cancel=true，快照为当时余额', async () => {
  f.clock.advanceMs(1_234);
  const u = await user(f);
  await seedBalance(f, u.appId, u.uid, 1_234n);
  const now = f.clock.now().getTime();
  const data = await deletion(await u.apply({ stepUp: await u.mint() }));
  expect(data).toMatchObject({
    status: 'cooling',
    can_cancel: true,
    cancelled_at: null,
    cancel_reason: null,
    processed_at: null,
  });
  expect(ms(data.apply_at)).toBe(now);
  expect(ms(data.cooling_until)).toBe(now + COOLING_MS);
  const rows = await requests(f, u.appId, u.uid);
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row).toMatchObject({
    status: 'cooling',
    cancelled_at: null,
    cancel_reason: null,
    processed_at: null,
    balance_snapshot_fen: 1_234n,
    row_version: 0,
  });
  expect(row.apply_at.getTime()).toBe(now);
  expect(row.cooling_until.getTime()).toBe(now + COOLING_MS);
  expect(row.created_at.getTime()).toBe(now);
  expect(row.updated_at.getTime()).toBe(now);
  // UUIDv7 id (domain generator).
  expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it('[AC-B1-15d#2] 两个端口都在调用方事务内、持有本人 users 行锁时读取', async () => {
  const u = await user(f);
  await deletion(await u.apply({ stepUp: await u.mint() }));
  const inFlight = inFlightCallsOf(u.appId, u.uid);
  expect(inFlight).toHaveLength(1);
  expect(inFlight[0]).toMatchObject({ inTransaction: true, userRowLocked: true });
  const balance = balanceCallsOf(u.appId, u.uid);
  expect(balance).toHaveLength(1);
  expect(balance[0]).toMatchObject({ inTransaction: true, userRowLocked: true });
});

it.each([
  ['无账户', null],
  ['余额为 0', '0'],
] as const)('[AC-B1-15d#3] %s 按 0 申请成功，快照为 0', async (_name, available) => {
  const u = await user(f);
  if (available !== null) await seedBalance(f, u.appId, u.uid, BigInt(available));
  const data = await deletion(await u.apply({ stepUp: await u.mint() }));
  expect(data.status).toBe('cooling');
  const rows = await requests(f, u.appId, u.uid);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.balance_snapshot_fen).toBe(0n);
});

it('[AC-B1-15d#4] 在途端口报 true → 30412（422、无 data）、无单、token 不核销；30412 随键保存', async () => {
  const u = await user(f);
  setInFlight(u.appId, u.uid, true);
  const token = await u.mint();
  const key = 'b15d0412-0000-4000-8000-000000000001';
  const refused = await u.apply({ stepUp: token, key });
  const body = await failed(refused, 422, 30412);
  expect(body).not.toHaveProperty('data');
  expect(await requests(f, u.appId, u.uid)).toEqual([]);
  expect(inFlightCallsOf(u.appId, u.uid)).toHaveLength(1);
  // The port now says "none": the stored 30412 is replayed for the same key, the port not asked.
  setInFlight(u.appId, u.uid, false);
  const replay = await u.apply({ stepUp: token, key });
  expect(replay.statusCode).toBe(422);
  expect(replay.payload).toBe(refused.payload);
  expect(inFlightCallsOf(u.appId, u.uid)).toHaveLength(1);
  // The token was not consumed by the 30412: a new key with the same token succeeds once.
  expect((await deletion(await u.apply({ stepUp: token }))).status).toBe('cooling');
  await stepUpRequired(await u.apply({ stepUp: token }));
  expect(await requests(f, u.appId, u.uid)).toHaveLength(1);
});

it('[AC-B1-15d#5] 在途端口报 false → 申请成功（是否在途的口径只归端口）', async () => {
  const u = await user(f);
  setInFlight(u.appId, u.uid, false);
  expect((await deletion(await u.apply({ stepUp: await u.mint() }))).status).toBe('cooling');
  expect(inFlightCallsOf(u.appId, u.uid)).toHaveLength(1);
});

it('[AC-B1-15d#6] available_fen = −500 → 30416、data.amount_fen=500、无单、token 不核销；回正后同 token 新键成功', async () => {
  const u = await user(f);
  await seedBalance(f, u.appId, u.uid, -500n);
  const token = await u.mint();
  const key = 'b15d0416-0000-4000-8000-000000000001';
  const refused = await u.apply({ stepUp: token, key });
  const body = await failed(refused, 422, 30416);
  expect(body['data']).toEqual({ amount_fen: 500 });
  expect(await requests(f, u.appId, u.uid)).toEqual([]);
  await f.db
    .withSchema('app')
    .updateTable('account_balances')
    .set({ available_fen: 0n })
    .where('app_id', '=', u.appId)
    .execute();
  // Stored with the key: the same key still answers the original 30416.
  const replay = await u.apply({ stepUp: token, key });
  expect(replay.statusCode).toBe(422);
  expect(replay.payload).toBe(refused.payload);
  const data = await deletion(await u.apply({ stepUp: token }));
  expect(data.status).toBe('cooling');
  const rows = await requests(f, u.appId, u.uid);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.balance_snapshot_fen).toBe(0n);
});

it('[AC-B1-15d#7] available_fen = −1 → 30416、data.amount_fen=1（取反为正数）', async () => {
  const u = await user(f);
  await seedBalance(f, u.appId, u.uid, -1n);
  const body = await failed(await u.apply({ stepUp: await u.mint() }), 422, 30416);
  expect(body['data']).toEqual({ amount_fen: 1 });
  expect(await requests(f, u.appId, u.uid)).toEqual([]);
});

it('[AC-B1-15d#8] 30412 与 30416 同时成立 → 30412', async () => {
  const u = await user(f);
  await seedBalance(f, u.appId, u.uid, -500n);
  setInFlight(u.appId, u.uid, true);
  const body = await failed(await u.apply({ stepUp: await u.mint() }), 422, 30412);
  expect(body).not.toHaveProperty('data');
  expect(await requests(f, u.appId, u.uid)).toEqual([]);
});

it('[AC-B1-15d#9] 已有 cooling 单再申请（新键）→ 返回原单、不新建、cooling_until 不变、不再问在途端口', async () => {
  const u = await user(f);
  const first = await deletion(await u.apply({ stepUp: await u.mint() }));
  f.clock.advanceMs(5_000);
  const second = await deletion(await u.apply({ stepUp: await u.mint() }));
  expect(second).toEqual(first);
  const rows = await requests(f, u.appId, u.uid);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.cooling_until.getTime()).toBe(ms(first.cooling_until));
  expect(inFlightCallsOf(u.appId, u.uid)).toHaveLength(1);
});

it('[AC-B1-15d#10] 已有 processing 单再申请 → 返回该单（can_cancel=false）、不新建；有余额为负也不另判', async () => {
  const u = await user(f);
  const applied = new Date(f.clock.now().getTime() - COOLING_MS - 60_000);
  await seedRequest(f, u.appId, u.uid, 'processing', applied);
  await seedBalance(f, u.appId, u.uid, -500n);
  const data = await deletion(await u.apply({ stepUp: await u.mint() }));
  expect(data).toMatchObject({ status: 'processing', can_cancel: false, processed_at: null });
  expect(ms(data.apply_at)).toBe(applied.getTime());
  expect(await requests(f, u.appId, u.uid)).toHaveLength(1);
});

it('[AC-B1-15d#11] 只有已撤回的历史单时可重新申请：新建一张 cooling 单', async () => {
  const u = await user(f);
  const old = new Date(f.clock.now().getTime() - 3 * 86_400_000);
  await seedRequest(f, u.appId, u.uid, 'cancelled', old);
  const data = await deletion(await u.apply({ stepUp: await u.mint() }));
  expect(data.status).toBe('cooling');
  expect(ms(data.apply_at)).toBe(f.clock.now().getTime());
  const rows = await requests(f, u.appId, u.uid);
  expect(rows.map((row) => row.status)).toEqual(['cancelled', 'cooling']);
});
