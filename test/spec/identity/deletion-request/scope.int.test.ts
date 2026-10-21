// B1-15d who may call the three operations (08 BR-ID-27, BR-ID-31, BR-ID-32, BR-ID-01 细则「受限会话」
// 「最低支持版本的接口层拦截」; brief §9.2 #9 item 10): app isolation of requests, balances and the
// in-flight port; a deletion_only session; an h5_token → 10403; a client below the minimum version
// is not 10405; a banned user may apply, read and cancel (10006 whitelist).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedUser } from '../registration/kit.ts';
import {
  balanceCallsOf,
  deletion,
  deletionData,
  failed,
  inFlightCallsOf,
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

it('[AC-B1-15d#31] 跨 app 隔离：另一 app 的单、余额、在途都不影响本 app 的查询、撤回与申请', async () => {
  const u = await user(f);
  const other = `${u.appId}_x`;
  // users.id is the primary key on its own, so the other app's account is a user of its own
  // (deletion_requests_user_fkey: (app_id, user_id) → users).
  const otherUid = await seedUser(f.db, other);
  const now = f.clock.now();
  await seedRequest(f, other, otherUid, 'cooling', now);
  await seedBalance(f, other, otherUid, -500n);
  setInFlight(other, otherUid, true);
  expect(await deletionData(await u.get())).toBeNull();
  expect(await deletionData(await u.cancel())).toBeNull();
  const data = await deletion(await u.apply({ stepUp: await u.mint() }));
  expect(data.status).toBe('cooling');
  const mine = await requests(f, u.appId, u.uid);
  expect(mine).toHaveLength(1);
  expect(mine[0]!.balance_snapshot_fen).toBe(0n);
  const theirs = await requests(f, other, otherUid);
  expect(theirs.map((row) => [row.status, row.row_version])).toEqual([['cooling', 0]]);
  expect(inFlightCallsOf(u.appId, u.uid)).toHaveLength(1);
  expect(inFlightCallsOf(other, otherUid)).toEqual([]);
  expect(balanceCallsOf(u.appId, u.uid)).toHaveLength(1);
  expect(balanceCallsOf(other, otherUid)).toEqual([]);
});

it('[AC-B1-15d#32] deletion_only 会话三条接口都可调用', async () => {
  const u = await user(f, { scope: 'deletion_only' });
  expect(await deletionData(await u.get())).toBeNull();
  expect((await deletion(await u.apply({ stepUp: await u.mint() }))).status).toBe('cooling');
  expect((await deletion(await u.get())).status).toBe('cooling');
  expect((await deletion(await u.cancel())).status).toBe('cancelled');
});

it('[AC-B1-15d#33] h5_token 调三条接口 → 10403，不建单', async () => {
  const u = await user(f);
  await failed(await u.get({ auth: 'h5' }), 403, 10403);
  await failed(await u.apply({ stepUp: await u.mint(), auth: 'h5' }), 403, 10403);
  await failed(await u.cancel({ auth: 'h5' }), 403, 10403);
  expect(await requests(f, u.appId, u.uid)).toEqual([]);
});

it('[AC-B1-15d#34] 客户端版本低于最低支持版本时三条接口不返回 10405', async () => {
  const u = await user(f, { minVersion: '3.0.0' });
  const version = '2.0.0';
  expect(await deletionData(await u.get({ version }))).toBeNull();
  const applied = await deletion(await u.apply({ stepUp: await u.mint(), version }));
  expect(applied.status).toBe('cooling');
  expect((await deletion(await u.cancel({ version }))).status).toBe('cancelled');
});

it('[AC-B1-15d#35] 封禁用户可申请、查询、撤回（10006 白名单）；在途口径归端口', async () => {
  const u = await user(f);
  await f.db.transaction().execute((trx) =>
    f.risk.setRiskState(trx, {
      app_id: u.appId,
      user_id: u.uid,
      state: 'banned',
      reason: 'b1-15d fixture',
      reason_category: 'other',
      frozen_until: null,
      changed_by: 'fixture_operator',
    }),
  );
  setInFlight(u.appId, u.uid, false);
  expect((await deletion(await u.apply({ stepUp: await u.mint() }))).status).toBe('cooling');
  expect((await deletion(await u.get())).status).toBe('cooling');
  expect((await deletion(await u.cancel())).status).toBe('cancelled');
});

it('[AC-B1-15d#38] 封禁用户申请注销仍须 step-up（BR-ID-31）：缺 token、action 不符 → 10003 且无单；合法 token 成功', async () => {
  const u = await user(f);
  await f.db.transaction().execute((trx) =>
    f.risk.setRiskState(trx, {
      app_id: u.appId,
      user_id: u.uid,
      state: 'banned',
      reason: 'b1-15d fixture',
      reason_category: 'other',
      frozen_until: null,
      changed_by: 'fixture_operator',
    }),
  );
  await stepUpRequired(await u.apply({ stepUp: null }));
  await stepUpRequired(await u.apply({ stepUp: await u.mint('withdraw') }));
  expect(await requests(f, u.appId, u.uid)).toEqual([]);
  expect(inFlightCallsOf(u.appId, u.uid)).toEqual([]);
  expect((await deletion(await u.apply({ stepUp: await u.mint() }))).status).toBe('cooling');
  expect(await requests(f, u.appId, u.uid)).toHaveLength(1);
});
