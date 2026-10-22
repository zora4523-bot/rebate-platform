import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  answer,
  close,
  fixture,
  fund,
  invariant,
  open,
  rows,
  state,
  TIMEOUT,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it(
  '[AC-B2-05d#10] 50 次并发同键只建一单，其余处理中或逐字重放，重新建 service 仍不重复',
  async () => {
    const f = await fixture(h);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 50 }, () => f.request(key)));
    const accepted = results.filter((r) => answer(r).code === 0);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => [0, 40901].includes(answer(r).code))).toBe(true);
    for (const result of accepted) expect(result.body).toBe(accepted[0]!.body);
    const before = await state(f);
    const replay = await f.request(key);
    expect(replay.body).toBe(accepted[0]!.body);
    expect(replay.source).toBe('replay');
    expect(await state(f)).toEqual(before);
    expect(before.withdrawals).toHaveLength(1);
    expect(before.vouchers).toHaveLength(1);
    expect(before.events).toHaveLength(2);
    expect(before.keys).toHaveLength(1);
    expect(before.keys[0]).toMatchObject({
      status: 'completed',
      method: 'POST',
      path: '/v1/withdrawals',
    });
    const retained = await sql<{
      forever: boolean;
    }>`SELECT expire_at = 'infinity'::timestamptz AS forever
    FROM app.idempotency_keys WHERE app_id=${f.actor.appId} AND key=${key}`.execute(h.db);
    expect(retained.rows).toEqual([{ forever: true }]);
    await invariant(f);
  },
  TIMEOUT,
);

it('[AC-B2-05d#11] 成功同键换金额返回 20901，不重复冻结', async () => {
  const f = await fixture(h);
  const key = randomUUID();
  expect(answer(await f.request(key)).code).toBe(0);
  const before = await state(f);
  expect(answer(await f.request(key, 2000n)).code).toBe(20901);
  expect(await state(f)).toEqual(before);
});

it('[AC-B2-05d#12] 30301 持久化；补入余额后同键逐字重放首次错误，新键可成功', async () => {
  const f = await fixture(h, { balance: 0n });
  const key = randomUUID();
  const first = await f.request(key);
  expect(answer(first)).toMatchObject({ code: 30301 });
  expect((await state(f)).keys).toHaveLength(1);
  await fund(h.db, f.ledger, f.actor, 2000n);
  expect((await f.request(key)).body).toBe(first.body);
  expect(await rows(f)).toEqual([]);
  expect(answer(await f.request()).code).toBe(0);
  await invariant(f);
});

it('[AC-B2-05d#13] 已作废键不比较请求体、不执行校验；返回 20903 且无资金变动', async () => {
  const f = await fixture(h);
  f.service();
  const key = randomUUID();
  await f.idempotency.abandon({
    appId: f.actor.appId,
    userId: f.actor.userId,
    action: 'withdraw',
    key,
    traceId: randomUUID(),
  });
  f.options.rules.reverify = {
    check: async () => {
      throw new Error('abandoned key ran business');
    },
  };
  const before = await state(f);
  expect(answer(await f.request(key, 2000n)).code).toBe(20903);
  expect(await state(f)).toEqual(before);
});

it('[AC-B2-05d#14] 1xxxx 不缓存，同键补齐劳务协议后可申请', async () => {
  const f = await fixture(h);
  const key = randomUUID();
  f.options.rules.laborAgreementSigned = async () => false;
  expect(answer(await f.request(key))).toMatchObject({
    code: 10004,
    data: { consent_type: 'labor_agreement' },
  });
  const s = await state(f);
  expect(s.keys).toEqual([]);
  expect(s.withdrawals).toEqual([]);
  f.options.rules.laborAgreementSigned = async () => true;
  expect(answer(await f.request(key)).code).toBe(0);
});

it('[AC-B2-05d#15] 同键跨 app、跨用户独立，身份来自调用方 actor', async () => {
  const a = await fixture(h);
  const b = await fixture(h);
  const c = await fixture(h, { appId: a.actor.appId });
  const key = randomUUID();
  for (const f of [a, b, c]) expect(answer(await f.request(key)).code).toBe(0);
  const all = [...(await rows(a)), ...(await rows(b))];
  expect(all).toHaveLength(3);
  expect(new Set(all.map((w) => w.id)).size).toBe(3);
  expect(all.map((w) => [w.app_id, w.user_id])).toEqual(
    expect.arrayContaining([a, b, c].map((f) => [f.actor.appId, f.actor.userId])),
  );
  await invariant(a);
  await invariant(b);
});
