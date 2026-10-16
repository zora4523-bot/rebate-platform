// B1-02y: one use of a step_up_token (规划/08 BR-ID-08: jti consumed only by a successful business
// request — HTTP 2xx and code 0; any error code leaves it usable while valid; ruling §9.3 #3 D12:
// reserved in Redis while judged, consumed on success, released otherwise; Redis unavailable while
// judging → 50001, while settling → one warn line, response unchanged; no token or jti in logs),
// and the replay that never judges it (BR-ID-08, BR-ID-01 ④ 细则: a completed key returns the
// original response even with an expired or consumed token).
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import {
  TTL_SECONDS,
  failed,
  linesSince,
  openFixture,
  stepUpRequired,
  succeeded,
  user,
  type Fixture,
} from './kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openFixture();
}, 180_000);
afterEach(() => {
  f?.setRedisFault('none');
});
afterAll(async () => {
  await f?.close();
});

it('[AC-B1-02y#10] 成功后同一 token 换新幂等键再提交返回 10003，业务只执行一次', async () => {
  const u = await user(f);
  const token = await u.mint();
  succeeded(await u.send('deletion', { stepUp: token }));
  expect(u.handled()).toBe(1);
  await stepUpRequired(await u.send('deletion', { stepUp: token }));
  await stepUpRequired(await u.send('deletion', { stepUp: token, body: { other: 'body' } }));
  expect(u.handled()).toBe(1);
  // Consumed for this user's operations only by jti: a new token of the same action passes.
  succeeded(await u.send('deletion', { stepUp: await u.mint() }));
  expect(u.handled()).toBe(2);
});

it('[AC-B1-02y#11] 业务返回已存储的非零码（30412）后，同一 token 换新键可再用一次', async () => {
  const u = await user(f);
  const token = await u.mint();
  u.plan('refused_stored');
  failed(await u.send('deletion', { stepUp: token }), 422, 30412);
  expect(u.handled()).toBe(1);
  succeeded(await u.send('deletion', { stepUp: token }));
  expect(u.handled()).toBe(2);
  await stepUpRequired(await u.send('deletion', { stepUp: token }));
  expect(u.handled()).toBe(2);
});

it('[AC-B1-02y#12] 业务返回不存储的错误码（20002）后，沿用原幂等键与同一 token 重提通过', async () => {
  const u = await user(f);
  const token = await u.mint();
  const key = randomUUID();
  u.plan('refused_unstored');
  failed(await u.send('deletion', { stepUp: token, key }), 400, 20002);
  expect(u.handled()).toBe(1);
  succeeded(await u.send('deletion', { stepUp: token, key }));
  expect(u.handled()).toBe(2);
  await stepUpRequired(await u.send('deletion', { stepUp: token }));
  expect(u.handled()).toBe(2);
});

it('[AC-B1-02y#13] 业务抛错回滚后，同一 token 沿用原键重提通过，成功后才核销', async () => {
  const u = await user(f);
  const token = await u.mint();
  const key = randomUUID();
  u.plan('throw');
  failed(await u.send('deletion', { stepUp: token, key }), 500, 50001);
  expect(u.handled()).toBe(1);
  succeeded(await u.send('deletion', { stepUp: token, key }));
  expect(u.handled()).toBe(2);
  await stepUpRequired(await u.send('deletion', { stepUp: token }));
  expect(u.handled()).toBe(2);
});

it('[AC-B1-02y#14] 同键回放返回原响应且不校验 token：过期、已核销或不带 token 都回放；换请求体是 20901', async () => {
  const u = await user(f);
  const token = await u.mint();
  const key = randomUUID();
  const body = { fixture: 'replayed' };
  const first = await u.send('deletion', { stepUp: token, key, body });
  succeeded(first);
  expect(u.handled()).toBe(1);
  const replay = await u.send('deletion', { stepUp: token, key, body });
  expect(replay.statusCode).toBe(200);
  expect(replay.payload).toBe(first.payload);
  f.clock.advanceMs((TTL_SECONDS + 60) * 1000);
  for (const stepUp of [token, null, 'not-a-jwt']) {
    const later = await u.send('deletion', { stepUp, key, body });
    expect(later.statusCode).toBe(200);
    expect(later.payload).toBe(first.payload);
  }
  failed(await u.send('deletion', { stepUp: null, key, body: { fixture: 'changed' } }), 409, 20901);
  expect(u.handled()).toBe(1);
});

it('[AC-B1-02y#15] 两个不同幂等键并发提交同一 token：只有一个进入业务，另一个 10003', async () => {
  const u = await user(f);
  const token = await u.mint();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  u.plan({ hold, entered });
  const first = u.send('deletion', { stepUp: token });
  try {
    // The first request is inside the business (its token reserved) or already answered.
    await Promise.race([inside, first]);
    const second = await u.send('deletion', { stepUp: token });
    await stepUpRequired(second);
    expect(u.handled()).toBe(1);
  } finally {
    release();
  }
  succeeded(await first);
  expect(u.handled()).toBe(1);
  await stepUpRequired(await u.send('deletion', { stepUp: token }));
});

it('[AC-B1-02y#16] 校验时 Redis 不可用返回 50001、业务不执行、token 未被占用', async () => {
  const u = await user(f);
  const token = await u.mint();
  const key = randomUUID();
  f.setRedisFault('post_miss');
  failed(await u.send('deletion', { stepUp: token, key }), 500, 50001);
  expect(u.handled()).toBe(0);
  f.setRedisFault('none');
  succeeded(await u.send('deletion', { stepUp: token, key }));
  expect(u.handled()).toBe(1);
  await stepUpRequired(await u.send('deletion', { stepUp: token }));
  expect(u.handled()).toBe(1);
});

it('[AC-B1-02y#17] 收尾时 Redis 失败只写一条 warn、响应不变；该 token 仍不可再用；日志不含 token 与 jti', async () => {
  const u = await user(f);
  const token = await u.mint();
  const jti = (
    JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { jti: string }
  ).jti;
  const from = f.lines.length;
  u.plan('ok_then_redis_down');
  const response = await u.send('deletion', { stepUp: token });
  f.setRedisFault('none');
  succeeded(response);
  expect(u.handled()).toBe(1);
  const written = linesSince(f, from);
  expect(written.filter((line) => line['level'] === 40)).toHaveLength(1);
  expect(written.filter((line) => Number(line['level']) >= 50)).toHaveLength(0);
  await stepUpRequired(await u.send('deletion', { stepUp: token }));
  expect(u.handled()).toBe(1);
  const all = f.lines.join('\n');
  expect(all).not.toContain(token);
  expect(all).not.toContain(token.split('.')[2]!);
  expect(all).not.toContain(jti);
});
