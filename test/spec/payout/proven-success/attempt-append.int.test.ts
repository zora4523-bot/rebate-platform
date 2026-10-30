// B2-07e attempt-append rule tests (claude-independent, SPEC_REF 37808a50): 规划/08 BR-WDR-08 W11
// (尝试记录 kind=query、result=success，凭证为账单行) and task §9.3 (D10-428): the payout process,
// as couli_payout, takes the job W11 queued and appends one attempt row — request
// { source: 'w11', recon_diff_id, bill_date, operator }, response the bill line's summary,
// resp_code 'BILL_LINE', result 'success' — idempotent on (withdrawal_id, recon_diff_id): a
// redelivered job appends nothing more; existing rows are never changed; nothing else is written.
// A failed append is thrown for the queue's retry; the last attempt (retryLimit + 1) also logs
// logger.error with the alert payout_attempt_append_failed (ids only).
// The job is the one W11's port queued (recorded by the kit's queue), so the payload is W11's own.
// Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ATTEMPT_RETRY_LIMIT,
  BILL_DATE,
  PAYEE_NAME,
  TIMEOUT,
  appendSends,
  attemptRows,
  channelOrderOf,
  close,
  failingInserts,
  open,
  setup,
  withdrawalRow,
  withdrawalVouchers,
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
  '[AC-B2-07e#12] payout 进程（couli_payout）处理 W11 入队的 attempt-append 任务：追加恰一条 kind=query、result=success、resp_code BILL_LINE 的尝试记录，request 记 source=w11、recon_diff_id、bill_date、operator，response 为账单行摘要（含渠道单号、不含收款人信息）；原有的转账失败记录一字不改；不改提现单、不记账',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const w = await f.seed();
    const request = f.input(w);
    await f.prove(request, port);
    const [queued] = appendSends(f);
    expect(queued, 'W11 必须入队 attempt-append 任务').toBeDefined();
    const original = await attemptRows(h.observer, f.appId, w.id);
    const withdrawal = await withdrawalRow(h.observer, f.appId, w.id);
    const vouchers = await withdrawalVouchers(h.observer, f.appId);
    const handler = f.appendJob();

    await handler(f.received(queued!));

    const rows = await attemptRows(h.observer, f.appId, w.id);
    expect(rows).toHaveLength(original.length + 1);
    for (const row of original) expect(rows).toContainEqual(row);
    const added = rows.filter((row) => !original.some((old) => old.id === row.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      app_id: f.appId,
      withdrawal_id: w.id,
      kind: 'query',
      result: 'success',
      resp_code: 'BILL_LINE',
    });
    expect(added[0]!.request).toMatchObject({
      source: 'w11',
      recon_diff_id: request.reconDiffId,
      bill_date: BILL_DATE,
    });
    expect(added[0]!.request).toHaveProperty('operator');
    expect(added[0]!.response).not.toBeNull();
    expect(JSON.stringify(added[0]!.response)).toContain(channelOrderOf(w));
    expect(JSON.stringify([added[0]!.request, added[0]!.response])).not.toContain(PAYEE_NAME);
    expect(await withdrawalRow(h.observer, f.appId, w.id)).toEqual(withdrawal);
    expect(await withdrawalVouchers(h.observer, f.appId)).toEqual(vouchers);
    expect(f.logger.error).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#13] 同一任务重复投递（第 2、3 次，或同一载荷的另一条任务）：按 (withdrawal_id, recon_diff_id) 幂等，不再追加；处理器正常结束、不告警',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const w = await f.seed();
    await f.prove(f.input(w), port);
    const [queued] = appendSends(f);
    expect(queued, 'W11 必须入队 attempt-append 任务').toBeDefined();
    const handler = f.appendJob();
    await handler(f.received(queued!));
    const once = await attemptRows(h.observer, f.appId, w.id);

    await handler(f.received(queued!, 2));
    await handler(f.received(queued!, 3));
    await f.appendJob()(f.received(queued!));

    expect(await attemptRows(h.observer, f.appId, w.id)).toEqual(once);
    expect(
      (await attemptRows(h.observer, f.appId, w.id)).filter((row) => row.kind === 'query'),
    ).toHaveLength(1);
    expect(f.logger.error).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-07e#14] 两张单各自核销、各自的任务：每张单各追加自己的一条，互不影响（幂等键含 withdrawal_id）',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const first = await f.seed();
    const second = await f.seed({ net: 2500n });
    await f.prove(f.input(first), port);
    await f.prove(f.input(second), port);
    const sends = appendSends(f);
    expect(sends).toHaveLength(2);
    const handler = f.appendJob();

    for (const item of sends) await handler(f.received(item));

    for (const w of [first, second]) {
      const queries = (await attemptRows(h.observer, f.appId, w.id)).filter(
        (row) => row.kind === 'query',
      );
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatchObject({ withdrawal_id: w.id, result: 'success' });
    }
  },
  TIMEOUT,
);

/** Log fields and message as one text (bigint-safe). */
function logText(call: readonly unknown[]): string {
  return JSON.stringify(call, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

it(
  '[AC-B2-07e#40] 追加失败（数据库写不进去）：还有重试（第 1 次、第 retryLimit 次）→ 处理器抛出交给队列重试、不告警；最后一次（attempt = retryLimit + 1）仍失败 → 处理器抛出并 logger.error 告警 payout_attempt_append_failed，日志只带 id（不含收款人信息）；什么都没追加',
  async () => {
    const f = await setup(h);
    const port = f.port();
    const w = await f.seed();
    const request = f.input(w);
    await f.prove(request, port);
    const [queued] = appendSends(f);
    expect(queued, 'W11 必须入队 attempt-append 任务').toBeDefined();
    const original = await attemptRows(h.observer, f.appId, w.id);
    const broken = f.appendJob(h.payout.withPlugin(failingInserts('payout_attempts')));

    for (const attempt of [1, ATTEMPT_RETRY_LIMIT]) {
      await expect(broken(f.received(queued!, attempt)), `attempt ${attempt}`).rejects.toThrow();
      expect(f.logger.error, `attempt ${attempt}`).not.toHaveBeenCalled();
    }

    await expect(broken(f.received(queued!, ATTEMPT_RETRY_LIMIT + 1))).rejects.toThrow();
    expect(f.logger.error).toHaveBeenCalledTimes(1);
    const text = logText(f.logger.error.mock.calls[0]!);
    expect(text).toContain('payout_attempt_append_failed');
    expect(text).toContain(w.id);
    expect(text).not.toContain(PAYEE_NAME);
    expect(await attemptRows(h.observer, f.appId, w.id)).toEqual(original);
  },
  TIMEOUT,
);
