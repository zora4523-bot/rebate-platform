// B2-06e ⑤ (规划/08 BR-WDR-14, BR-WDR-28): one query point tries at most 3 times, 10 seconds apart
// (the injected sleep, never a real wait), and stops at the first success / fail; every try is
// one kind=query attempt (request { out_biz_no, point, try }); the tries are not transfers. Three
// unknown results — "order does not exist", processing, a status outside query_status_map, a
// system error, a timeout, a network error, nothing to say, a payer-side code — leave the
// withdrawal PAYING and enqueue the next point on the handler's transaction: singletonKey
// `${id}:${seq}:query:${n + 1}`, delaySeconds = T + offset(n + 1) − now, T being this
// withdrawal's (only) transfer attempt. A query never pauses the queue.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  DEALING_STEP,
  HOUR,
  MINUTE,
  NETWORK_STEP,
  NOT_FOUND_STEP,
  PAYER_SIDE_CODE_STEP,
  QUERY_FAIL_STEP,
  RETRY_GAP_MS,
  SYSTEM_ERROR_STEP,
  TIMEOUT,
  TIMEOUT_STEP,
  UNKNOWN_STEP,
  UNLISTED_STATUS_STEP,
  at,
  balanceOf,
  close,
  configOf,
  expectNoPayeeInLogs,
  jobsOf,
  open,
  queryAttempts,
  queryJobRow,
  queryScripted,
  querySends,
  querySuccess,
  querySummary,
  setup,
  withdrawal,
  type Harness,
  type QueryStep,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-06e#5] T+5 分的时点三次都未知：查询 3 次、其间等待 2 次各 10000 毫秒（查询与等待交替），三行 unknown 尝试，单据与余额不变，同一事务投 point 2，延迟 25 分 = 1500 秒', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedPaying(at(-5 * MINUTE), { userId: owner, net: 600n });
  const order: string[] = [];
  const ch = queryScripted(
    { [w.outBizNo]: [UNKNOWN_STEP, UNKNOWN_STEP, UNKNOWN_STEP] },
    {
      before: async () => {
        order.push('query');
      },
    },
  );
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
    order.push('sleep');
  });
  const handler = f.queryJob(ch.channel, { sleep });
  const before = await withdrawal(f, w.id);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();

  expect(ch.queries()).toEqual([w.outBizNo, w.outBizNo, w.outBizNo]);
  expect(ch.transfers()).toBe(0);
  expect(sleep.mock.calls).toEqual([[RETRY_GAP_MS], [RETRY_GAP_MS]]);
  expect(order).toEqual(['query', 'sleep', 'query', 'sleep', 'query']);
  expect(await querySummary(f, w.id)).toEqual([
    ['unknown', 1, 1],
    ['unknown', 1, 2],
    ['unknown', 1, 3],
  ]);
  expect(await withdrawal(f, w.id)).toEqual(before);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_400n, frozen_fen: 600n });
  expect(await jobsOf(f, w.id)).toEqual([queryJobRow(w, 2, 1500)]);
  const sends = querySends(f);
  expect(sends).toEqual([
    expect.objectContaining({
      singletonKey: `${w.id}:${w.executeSeq}:query:2`,
      delaySeconds: 1500,
    }),
  ]);
  expect(sends[0]?.trx?.isTransaction).toBe(true);
  expect(f.pause).not.toHaveBeenCalled();
  expectNoPayeeInLogs(f);
});

/**
 * What each of the three query attempts must record: the channel's codes and its response (W10
 * later relies on "the last query said the order does not exist"), no code at all when the call
 * never answered; `{}` pins nothing beyond the summary.
 */
function answered(code: string, subCode: string | null): Record<string, unknown> {
  return { resp_code: code, resp_sub_code: subCode, response: expect.anything() };
}
const NO_ANSWER: Record<string, unknown> = { resp_code: null };

const UNKNOWNS: readonly (readonly [string, QueryStep, Record<string, unknown>])[] = [
  ['查询返回「订单不存在」', NOT_FOUND_STEP, answered('40004', 'ORDER_NOT_EXIST')],
  ['处理中（10000 + DEALING）', DEALING_STEP, answered('10000', null)],
  ['query_status_map 之外的状态', UNLISTED_STATUS_STEP, {}],
  ['SYSTEM_ERROR', SYSTEM_ERROR_STEP, answered('20000', 'SYSTEM_ERROR')],
  ['10 秒超时（TimeoutError）', TIMEOUT_STEP, NO_ANSWER],
  ['网络错误（调用被拒绝）', NETWORK_STEP, NO_ANSWER],
  ['通道没有可说的结果', UNKNOWN_STEP, {}],
  ['付款方侧的码（查询里只算未知）', PAYER_SIDE_CODE_STEP, {}],
];

it.each(UNKNOWNS)(
  '[AC-B2-06e#5] %s 三次：都算未知——保持 PAYING、三行 unknown 尝试（记下通道返回的码与响应）、不暂停队列，投 point 1（T+1 分时投，延迟 4 分 = 240 秒）',
  async (_label, step, recorded) => {
    const f = await setup(h);
    const w = await f.seedPaying(at(-1 * MINUTE));
    const ch = queryScripted({ [w.outBizNo]: [step, step, step] });
    const handler = f.queryJob(ch.channel);
    const before = await withdrawal(f, w.id);
    await expect(handler(f.queryJobOf(w, 0))).resolves.toBeUndefined();
    expect(ch.queries()).toHaveLength(3);
    expect(ch.transfers()).toBe(0);
    expect(f.sleep.mock.calls).toEqual([[RETRY_GAP_MS], [RETRY_GAP_MS]]);
    expect(await querySummary(f, w.id)).toEqual([
      ['unknown', 0, 1],
      ['unknown', 0, 2],
      ['unknown', 0, 3],
    ]);
    expect(await queryAttempts(f, w.id)).toEqual(
      [1, 2, 3].map(() => expect.objectContaining(recorded)),
    );
    expect(await withdrawal(f, w.id)).toEqual(before);
    expect(await jobsOf(f, w.id)).toEqual([queryJobRow(w, 1, 240)]);
    expect(f.pause).not.toHaveBeenCalled();
    expect(await configOf(f, 'payout.queue_paused')).toBe(false);
  },
);

it('[AC-B2-06e#5] 第 2 次就成功：只调用 2 次、等待 1 次，两行尝试（unknown、success），W5 落库，不再投任务', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedPaying(at(-5 * MINUTE), { userId: owner, net: 800n });
  const ch = queryScripted({
    [w.outBizNo]: [NOT_FOUND_STEP, querySuccess(`CH${w.outBizNo}`), UNKNOWN_STEP],
  });
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
  expect(ch.queries()).toEqual([w.outBizNo, w.outBizNo]);
  expect(f.sleep.mock.calls).toEqual([[RETRY_GAP_MS]]);
  expect(await querySummary(f, w.id)).toEqual([
    ['unknown', 1, 1],
    ['success', 1, 2],
  ]);
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'PAID_API',
    channel_order_id: `CH${w.outBizNo}`,
  });
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_200n, frozen_fen: 0n });
  expect(await jobsOf(f, w.id)).toEqual([]);
});

it('[AC-B2-06e#5] 第 2 次查到 fail：只调用 2 次，两行尝试（unknown、fail），W6 落库退回冻结，不再投任务', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedPaying(at(-5 * MINUTE), { userId: owner, net: 800n });
  const ch = queryScripted({ [w.outBizNo]: [DEALING_STEP, QUERY_FAIL_STEP, UNKNOWN_STEP] });
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
  expect(ch.queries()).toHaveLength(2);
  expect(f.sleep.mock.calls).toEqual([[RETRY_GAP_MS]]);
  expect(await querySummary(f, w.id)).toEqual([
    ['unknown', 1, 1],
    ['fail', 1, 2],
  ]);
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'FAILED',
    fail_code: 'TEST_QUERY_FAIL',
  });
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 2_000n, frozen_fen: 0n });
  expect(await jobsOf(f, w.id)).toEqual([]);
});

it('[AC-B2-06e#5] 超时、网络错误之后第 3 次成功：调用 3 次、等待 2 次，W5 落库', async () => {
  const f = await setup(h);
  const w = await f.seedPaying(at(-5 * MINUTE));
  const ch = queryScripted({
    [w.outBizNo]: [TIMEOUT_STEP, NETWORK_STEP, querySuccess(`CH${w.outBizNo}`)],
  });
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
  expect(ch.queries()).toHaveLength(3);
  expect(f.sleep.mock.calls).toEqual([[RETRY_GAP_MS], [RETRY_GAP_MS]]);
  expect(await querySummary(f, w.id)).toEqual([
    ['unknown', 1, 1],
    ['unknown', 1, 2],
    ['success', 1, 3],
  ]);
  expect((await withdrawal(f, w.id)).status).toBe('PAID_API');
  expect(await jobsOf(f, w.id)).toEqual([]);
});

it('[AC-B2-06e#5] T 取本单那条 kind=transfer 尝试：本单更早的 query 尝试不算 T，别的提现单更早的转账尝试也不算，point 2 的延迟仍是 1500 秒', async () => {
  const f = await setup(h);
  // A transfer attempt of another withdrawal, earlier than this one's T: T only looks at this withdrawal.
  await f.seedPaying(at(-30 * MINUTE));
  const w = await f.seedPaying(at(-5 * MINUTE));
  await f.seedAttempt(w.id, 'query', 'unknown', at(-6 * MINUTE), w.appId);
  const ch = queryScripted({ [w.outBizNo]: [UNKNOWN_STEP, UNKNOWN_STEP, UNKNOWN_STEP] });
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
  expect(await jobsOf(f, w.id)).toEqual([queryJobRow(w, 2, 1500)]);
});

it('[AC-B2-06e#5] 固定时点之后（point 4 = T+240 分）三次未知：投 point 5，延迟 120 分 = 7200 秒；execute_seq 取单据的', async () => {
  const f = await setup(h);
  const w = await f.seedPaying(at(-240 * MINUTE), { executeSeq: 3 });
  const ch = queryScripted({});
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 4))).resolves.toBeUndefined();
  expect(ch.queries()).toHaveLength(3);
  expect(await jobsOf(f, w.id)).toEqual([queryJobRow(w, 5, 7200, 3)]);
});

it('[AC-B2-06e#5] 任务晚到（point 1 在 T+40 分才执行，已过 point 2 的 T+30 分）：下一时点 point 2 的延迟为 0', async () => {
  const f = await setup(h);
  const w = await f.seedPaying(at(-40 * MINUTE));
  const ch = queryScripted({});
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 1))).resolves.toBeUndefined();
  expect(await jobsOf(f, w.id)).toEqual([queryJobRow(w, 2, 0)]);
});

it('[AC-B2-06e#5] T+2 小时的时点（point 3）三次未知：投 point 4，延迟 2 小时 = 7200 秒', async () => {
  const f = await setup(h);
  const w = await f.seedPaying(at(-2 * HOUR));
  const ch = queryScripted({});
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 3))).resolves.toBeUndefined();
  expect(await jobsOf(f, w.id)).toEqual([queryJobRow(w, 4, 7200)]);
});
