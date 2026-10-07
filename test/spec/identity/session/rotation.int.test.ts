import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { revokeSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import {
  openSuite,
  closeSuite,
  fixture,
  success,
  hash,
  MONTH,
  assertRevoked,
  brokenRedis,
  type Suite,
} from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

it('[AC-S1-171#2] 每次刷新轮换：哈希链、30天重计、JWT与设备指针保持同sid', async () => {
  const f = await fixture(suite);
  const device = await f.deviceRow();
  f.clock.advanceMs(86400_000);
  const pair = success(await f.refresh());
  expect(pair.refresh_token).not.toBe(f.initial.refresh_token);
  expect(pair.access_token).not.toBe(f.initial.access_token);
  expect(pair.session_scope).toBe('full');
  expect(new Date(pair.refresh_expires_at).getTime()).toBe(f.clock.now().getTime() + MONTH);
  expect(new Date(pair.access_expires_at).getTime()).toBe(f.clock.now().getTime() + 7200_000);
  expect(await f.tokens.verifyAccess(pair.access_token)).toEqual({
    uid: f.uid,
    app_id: f.appId,
    device_id: f.deviceId,
    sid: f.initial.sid,
    scp: 'full',
  });
  const rows = await f.chain();
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.token_hash === hash(f.initial.refresh_token))).toMatchObject({
    rotated_at: f.clock.now(),
    parent_hash: null,
  });
  expect(rows.find((row) => row.token_hash === hash(pair.refresh_token))).toMatchObject({
    sid: f.initial.sid,
    parent_hash: hash(f.initial.refresh_token),
    rotated_at: null,
    expire_at: new Date(f.clock.now().getTime() + MONTH),
  });
  expect(JSON.stringify(rows)).not.toContain(pair.refresh_token);
  expect(await f.deviceRow()).toEqual(device);
  const next = success(await f.refresh({ refresh_token: pair.refresh_token }));
  expect(next.refresh_token).not.toBe(pair.refresh_token);
  expect(await f.chain()).toHaveLength(3);
  await expect(f.access(pair.access_token)).resolves.toBeUndefined();
  for (const secret of [pair.access_token, pair.refresh_token, hash(pair.refresh_token)])
    expect(f.lines.join('')).not.toContain(secret);
});

it('[AC-S1-171#2] 宽限数据以指定context加密，Redis TTL为30秒且不含明文令牌', async () => {
  const f = await fixture(suite);
  const ns = suite.redis.namespace('refresh_grace');
  const set = vi.fn(ns.set.bind(ns));
  const redis = {
    ...suite.redis,
    namespace: (name: string) =>
      name === 'refresh_grace' ? { ...ns, set } : suite.redis.namespace(name),
  };
  const pair = success(await f.refresh({}, { redis }));
  const ciphertext = await ns.get(hash(f.initial.refresh_token));
  expect(set).toHaveBeenCalledWith(hash(f.initial.refresh_token), expect.any(String), 30);
  expect(ciphertext).toEqual(expect.any(String));
  expect(ciphertext).not.toContain(pair.refresh_token);
  expect(ciphertext).not.toContain(pair.access_token);
  const plaintext = suite.crypto.decrypt(ciphertext!, 'identity.refresh_grace');
  expect(() => JSON.parse(plaintext) as unknown).not.toThrow();
  for (const value of Object.values(pair)) expect(plaintext).toContain(value);
  const ttl = await ns.eval("return redis.call('PTTL', KEYS[1])", {
    keys: [hash(f.initial.refresh_token)],
    args: [],
    ttlSeconds: 30,
  });
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(30_000);
});

for (const elapsed of [10_000, 30_000]) {
  it(`[AC-S1-171#2] ${elapsed}ms同设备重提返回逐字相同令牌对，不重新判作用域`, async () => {
    const f = await fixture(suite);
    f.minimum.mockResolvedValue('3.0.0');
    const pair = success(await f.refresh());
    expect(pair.session_scope).toBe('deletion_only');
    const before = await f.chain();
    f.clock.advanceMs(elapsed);
    const again = success(await f.refresh({ version: '4.0.0' }));
    expect(again).toEqual(pair);
    expect(await f.chain()).toEqual(before);
    expect((await f.session()).revoked_at).toBeNull();
    expect(f.afterRevoked).not.toHaveBeenCalled();
  });
}
for (const elapsed of [30_001, 31_000]) {
  it(`[AC-S1-171#3] ${elapsed}ms旧令牌复用吊销整条sid，即使Redis键仍在`, async () => {
    const f = await fixture(suite);
    const pair = success(await f.refresh());
    f.clock.advanceMs(elapsed);
    expect(await f.refresh()).toEqual({ code: 10404 });
    await assertRevoked(f, pair.refresh_token);
    expect(f.afterRevoked).toHaveBeenCalledTimes(1);
    expect(f.afterRevoked.mock.calls[0]![1]).toEqual([f.initial.sid]);
  });
}
it('[AC-S1-171#3] R2已轮换，8秒时重提R1也吊销R3所属sid；旧sid不触碰新登录指针', async () => {
  const f = await fixture(suite);
  const pair = success(await f.refresh());
  f.clock.advanceMs(5000);
  const third = success(await f.refresh({ refresh_token: pair.refresh_token }));
  const newer = await f.issue();
  const device = await f.deviceRow();
  f.clock.advanceMs(3000);
  expect(await f.refresh()).toEqual({ code: 10404 });
  await assertRevoked(f, third.refresh_token);
  expect(await f.deviceRow()).toEqual(device);
  expect(device.last_login_sid).toBe(newer.sid);
  expect((await f.session(newer.sid)).revoked_at).toBeNull();
  expect((await f.refresh({ refresh_token: newer.refresh_token })).code).toBe(0);
});
it('[AC-S1-171#3] Redis无记录按复用吊销，读失败50001保留会话并可恢复宽限', async () => {
  const f = await fixture(suite);
  const pair = success(await f.refresh());
  const before = await f.session();
  const chain = await f.chain();
  expect(await f.refresh({}, { redis: brokenRedis(suite.redis, 'get') })).toEqual({ code: 50001 });
  expect(await f.session()).toEqual(before);
  expect(await f.chain()).toEqual(chain);
  expect(f.afterRevoked).not.toHaveBeenCalled();
  expect(success(await f.refresh())).toEqual(pair);
  await suite.redis.namespace('refresh_grace').eval("return redis.call('DEL', KEYS[1])", {
    keys: [hash(f.initial.refresh_token)],
    args: [],
    ttlSeconds: 30,
  });
  expect(await f.refresh()).toEqual({ code: 10404 });
  await assertRevoked(f, pair.refresh_token);
});
it('[AC-S1-171#2] Redis写失败50001，轮换事务回滚，原令牌仍可再次轮换', async () => {
  const f = await fixture(suite);
  const chain = await f.chain();
  const session = await f.session();
  const device = await f.deviceRow();
  expect(await f.refresh({}, { redis: brokenRedis(suite.redis, 'set') })).toEqual({ code: 50001 });
  expect(await f.chain()).toEqual(chain);
  expect(await f.session()).toEqual(session);
  expect(await f.deviceRow()).toEqual(device);
  expect(f.afterRevoked).not.toHaveBeenCalled();
  expect((await f.refresh()).code).toBe(0);
});
for (const rotated of [false, true]) {
  it(`[AC-S1-171#4] 设备不符（rotated=${rotated}）不签发、整条吊销、原设备也10404`, async () => {
    const f = await fixture(suite);
    if (rotated) success(await f.refresh());
    const chain = await f.chain();
    const other = await f.device();
    const issueAccess = vi.fn(f.tokens.issueAccess.bind(f.tokens));
    const issueRefresh = vi.fn(f.tokens.issueRefresh.bind(f.tokens));
    expect(
      await f.refresh(
        { verifiedDevice: { appId: f.appId, deviceId: other } },
        {
          tokens: { ...f.tokens, issueAccess, issueRefresh },
        },
      ),
    ).toEqual({ code: 10404 });
    expect(issueAccess).not.toHaveBeenCalled();
    expect(issueRefresh).not.toHaveBeenCalled();
    expect(await f.chain()).toEqual(chain);
    await assertRevoked(f);
  });
}
for (const elapsed of [MONTH, 31 * 86400_000]) {
  it(`[AC-S1-171#5] refresh到期边界${elapsed}ms返回10404不轮换`, async () => {
    const f = await fixture(suite);
    const chain = await f.chain();
    const session = await f.session();
    f.clock.advanceMs(elapsed);
    expect(await f.refresh()).toEqual({ code: 10404 });
    expect(await f.chain()).toEqual(chain);
    expect(await f.session()).toEqual(session);
    expect((await f.session()).revoked_at).toBeNull();
    expect(f.afterRevoked).not.toHaveBeenCalled();
  });
}
it('[AC-S1-171#2] 轮换后退出登录，30秒宽限内重提R1仍10404且保留logout原因', async () => {
  const f = await fixture(suite);
  success(await f.refresh());
  await f.db
    .transaction()
    .execute((trx) =>
      revokeSession(trx, { app_id: f.appId, sid: f.initial.sid, reason: 'logout' }, f.clock),
    );
  const revoked = await f.session();
  const chain = await f.chain();
  expect(revoked).toMatchObject({ revoked_at: f.clock.now(), revoke_reason: 'logout' });
  f.clock.advanceMs(10_000);
  expect(
    await suite.redis.namespace('refresh_grace').get(hash(f.initial.refresh_token)),
  ).not.toBeNull();
  expect(await f.refresh()).toEqual({ code: 10404 });
  expect(await f.session()).toEqual(revoked);
  expect(await f.chain()).toEqual(chain);
  expect(f.afterRevoked).not.toHaveBeenCalled();
});
it('[AC-S1-171#5] 已吊销和未知令牌10404；未知令牌不影响其他会话', async () => {
  const f = await fixture(suite);
  const before = await f.session();
  expect(await f.refresh({ refresh_token: 'unknown-refresh-value' })).toEqual({ code: 10404 });
  expect(await f.session()).toEqual(before);
  await f.db
    .transaction()
    .execute((trx) =>
      revokeSession(trx, { app_id: f.appId, sid: f.initial.sid, reason: 'admin_revoked' }, f.clock),
    );
  const revoked = await f.session();
  const chain = await f.chain();
  expect(await f.refresh()).toEqual({ code: 10404 });
  expect(await f.session()).toEqual(revoked);
  expect(await f.chain()).toEqual(chain);
});
it('[AC-ACC-05][BR-ID-07] 哈希查找限定已验证设备的app，跨app提交不泄露或吊销原会话', async () => {
  const first = await fixture(suite);
  const second = await fixture(suite);
  const before = await first.session();
  const other = await second.session();
  expect(await second.refresh({ refresh_token: first.initial.refresh_token })).toEqual({
    code: 10404,
  });
  expect(await first.session()).toEqual(before);
  expect(await second.session()).toEqual(other);
  expect((await first.refresh()).code).toBe(0);
});
it('[AC-S1-171#2] 真实PG并发刷新返回同一对，只有一个直接后继', async () => {
  const f = await fixture(suite);
  // issueRefresh is synchronous; hold the asynchronous signing port inside the transaction.
  // Without a row lock, both requests can read R1 before either commits. With a row lock,
  // only the first reaches signing, so the short timeout must also release the barrier.
  const barrier = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let arrivals = 0;
  const issueAccess = vi.fn<typeof f.tokens.issueAccess>(async (principal) => {
    arrivals += 1;
    if (arrivals === 1) timer = setTimeout(() => barrier.resolve(), 500);
    else barrier.resolve();
    await barrier.promise;
    return f.tokens.issueAccess(principal);
  });
  const ports = { tokens: { ...f.tokens, issueAccess } };
  const pending = [f.refresh({}, ports), f.refresh({}, ports)];
  const results = await Promise.allSettled(pending);
  if (timer !== undefined) clearTimeout(timer);
  barrier.resolve();
  const [left, right] = results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  expect(left).toBeDefined();
  expect(right).toBeDefined();
  expect(success(left!)).toEqual(success(right!));
  const chain = await f.chain();
  expect(chain).toHaveLength(2);
  expect(chain.filter((row) => row.parent_hash === hash(f.initial.refresh_token))).toHaveLength(1);
  expect((await f.session()).revoked_at).toBeNull();
});
for (const recovery of ['upgrade', 'lower-minimum', 'delete-minimum'] as const) {
  it(`[AC-S1-83#18] 低版本得到deletion_only，${recovery}刷新恢复full且sid不变`, async () => {
    const f = await fixture(suite);
    f.minimum.mockResolvedValue('3.0.0');
    const restricted = success(await f.refresh());
    expect(restricted.session_scope).toBe('deletion_only');
    expect(await f.tokens.verifyAccess(restricted.access_token)).toMatchObject({
      sid: f.initial.sid,
      scp: 'deletion_only',
    });
    f.minimum.mockResolvedValue(
      recovery === 'delete-minimum' ? null : recovery === 'lower-minimum' ? '1.0.0' : '3.0.0',
    );
    const full = success(
      await f.refresh({
        refresh_token: restricted.refresh_token,
        version: recovery === 'upgrade' ? '3.0.0' : '2.0.0',
      }),
    );
    expect(full.session_scope).toBe('full');
    expect(await f.tokens.verifyAccess(full.access_token)).toMatchObject({
      sid: f.initial.sid,
      scp: 'full',
    });
    expect(f.minimum).toHaveBeenCalledWith(f.appId, 'ios', 'appstore');
  });
}
it('[AC-S1-83#12] 平台和渠道按本次请求读取，不沿用设备注册资料', async () => {
  const f = await fixture(suite);
  f.minimum.mockImplementation(async (_app, platform, channel) =>
    platform === 'android' && channel === 'official' ? '9.0.0' : null,
  );
  const pair = success(
    await f.refresh({ platform: 'android', channel: 'official', version: '1.0.0' }),
  );
  expect(pair.session_scope).toBe('deletion_only');
  expect(f.minimum).toHaveBeenCalledWith(f.appId, 'android', 'official');
  const full = success(
    await f.refresh({
      refresh_token: pair.refresh_token,
      platform: 'ios',
      channel: 'appstore',
      version: '1.0.0',
    }),
  );
  expect(full.session_scope).toBe('full');
});
