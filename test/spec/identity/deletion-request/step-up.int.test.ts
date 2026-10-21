// B1-15d POST /v1/me/deletion step-up and idempotency (08 BR-ID-08, BR-ID-27, BR-ID-01 ④ ⑫;
// brief §9.2 #3): a missing / expired / other-action token is 10003 and writes nothing; a success
// consumes the token; the same key replays the original response without checking step-up again;
// an abandoned key is 20903 and another body under a used key is 20901.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TTL_SECONDS,
  deletion,
  failed,
  inFlightCallsOf,
  openFixture,
  requests,
  stepUpRequired,
  user,
  type Fixture,
  type User,
} from './kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

const BAD_TOKENS: readonly [string, (u: User) => Promise<string | null>][] = [
  ['缺少 token', () => Promise.resolve(null)],
  [
    '过期 token',
    (u) =>
      u.mint('account_deletion', {
        issuedAt: Math.floor(f.clock.now().getTime() / 1000) - TTL_SECONDS - 1,
      }),
  ],
  ['action 不符（withdraw）', (u) => u.mint('withdraw')],
];

it.each(BAD_TOKENS)('[AC-B1-15d#12] %s → 10003、无单、不进入业务判定', async (_name, token) => {
  const u = await user(f);
  await stepUpRequired(await u.apply({ stepUp: await token(u) }));
  expect(await requests(f, u.appId, u.uid)).toEqual([]);
  expect(inFlightCallsOf(u.appId, u.uid)).toEqual([]);
});

it('[AC-B1-15d#13] 成功后同一 token 换新键 → 10003，仍只有一张单', async () => {
  const u = await user(f);
  const token = await u.mint();
  await deletion(await u.apply({ stepUp: token }));
  await stepUpRequired(await u.apply({ stepUp: token }));
  expect(await requests(f, u.appId, u.uid)).toHaveLength(1);
});

it('[AC-B1-15d#14] 同键重放返回原响应（逐字节），不再校验 step-up，只一张单', async () => {
  const u = await user(f);
  const key = randomUUID();
  const first = await u.apply({ stepUp: await u.mint(), key });
  await deletion(first);
  f.clock.advanceMs(2_000);
  const replay = await u.apply({ stepUp: null, key });
  expect(replay.statusCode).toBe(200);
  expect(replay.payload).toBe(first.payload);
  expect(await requests(f, u.appId, u.uid)).toHaveLength(1);
  expect(inFlightCallsOf(u.appId, u.uid)).toHaveLength(1);
});

it('[AC-B1-15d#15] 已作废的键 → 20903、无单、不进入业务判定；同一 token 换新键成功', async () => {
  const u = await user(f);
  const token = await u.mint();
  const key = randomUUID();
  const abandoned = await f.idempotency.abandon({
    appId: u.appId,
    userId: u.uid,
    action: 'account_deletion',
    key,
    traceId: randomUUID(),
  });
  expect(abandoned.status).toBe(200);
  await failed(await u.apply({ stepUp: token, key }), 409, 20903);
  expect(await requests(f, u.appId, u.uid)).toEqual([]);
  expect(inFlightCallsOf(u.appId, u.uid)).toEqual([]);
  expect((await deletion(await u.apply({ stepUp: token }))).status).toBe('cooling');
});

it('[AC-B1-15d#16] 已用过的键配不同请求体 → 20901，不新建', async () => {
  const u = await user(f);
  const key = randomUUID();
  await deletion(await u.apply({ stepUp: await u.mint(), key, body: {} }));
  await failed(await u.apply({ stepUp: await u.mint(), key, body: { other: 'body' } }), 409, 20901);
  expect(await requests(f, u.appId, u.uid)).toHaveLength(1);
});

it('[AC-B1-15d#17] 缺 Idempotency-Key → 20001、无单', async () => {
  const u = await user(f);
  await failed(await u.apply({ stepUp: await u.mint(), key: null }), 400, 20001);
  expect(await requests(f, u.appId, u.uid)).toEqual([]);
});
