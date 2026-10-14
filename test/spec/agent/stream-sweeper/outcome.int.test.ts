// B3-03e: what one pass leaves behind for a left-over run, through B3-03g's finalizeRun (BR-AI-23
// 细则「崩溃不改变结果」: no ending written → cancelled when a cancel is recorded, else 50001;
// BR-AI-15 退还: server-side ending without any card → 1 refunded, on the day of acceptance (+08:00);
// cancel counts as usual; an ending committed before the crash is the ending (以落库为准), and such
// a run is still a left-over to find: the source query has no end_reason condition; design §3.3,
// §3.5, §5.3).
import { createTestDatabase } from '@couli/db/testing';

import { expect, it } from 'vitest';

import {
  dayKeyOf,
  shouldRefund,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import {
  sweepStart,
  sweeperDefaults,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import {
  RECOVERED,
  draftOf,
  instance,
  memberKey,
  runRow,
  sessionRow,
  stored,
  usedOn,
} from '../stream-finalize/kit.ts';
import { RecordingFinalizer, at, leftover, sweeper, usePgEach } from './kit.ts';

const pg = usePgEach(createTestDatabase);

async function sweepAfter(lockMs: number) {
  const config = sweeperDefaults();
  const clock = at(lockMs + config.marginMs);
  const real = instance(pg.db, { clock });
  const finalizer = new RecordingFinalizer(real.ports.finalizer);
  const result = await sweeper(pg.db, finalizer, clock, config).sweepOnce(sweepStart());
  return { result, finalizer, nowMs: lockMs + config.marginMs };
}

it('[AC-B3-03e#5] 遗留 run（无终止原因、未出卡、无取消记录）一轮收尾：server_error、终态为 50001 帧、锁释放；受理日 23:59 受理、次日收尾，退还记在受理日', async () => {
  const acceptedAt = Date.parse('2026-10-06T23:59:40+08:00');
  const left = await leftover(pg.db, acceptedAt);
  const key = memberKey(left.subject);
  expect(await usedOn(pg.db, key, '2026-10-06')).toBe(1);

  const { result, finalizer, nowMs } = await sweepAfter(left.lockMs);
  expect(dayKeyOf(new Date(acceptedAt))).toBe('2026-10-06');
  expect(dayKeyOf(new Date(nowMs))).toBe('2026-10-07');
  expect(result).toMatchObject({ processed: 1, finalized: 1, failed: 0 });
  expect(finalizer.calls).toHaveLength(1);
  expect(finalizer.calls[0]?.outcome).toMatchObject({
    kind: 'final',
    frame: RECOVERED,
    refunded: true,
    wrote: true,
  });

  const row = await runRow(pg.db, left.runId);
  expect(row).toMatchObject({
    end_reason: 'server_error',
    settle_result: 'refunded',
    card_delivered: false,
  });
  expect(row['final_event']).toEqual(stored(RECOVERED));
  expect(row['accepted_at']).toEqual(new Date(acceptedAt));
  expect(await sessionRow(pg.db, left.sessionId)).toMatchObject({
    run_lock_run_id: null,
    run_lock_expires_at: null,
  });
  expect(await usedOn(pg.db, key, '2026-10-06')).toBe(0);
  expect(await usedOn(pg.db, key, '2026-10-07')).toBe(0);
});

it('[AC-B3-03e#6] 遗留 run 出过卡（S3 已提交）：一轮收尾为 server_error 50001、card_delivered 保持 true、照常计数不退', async () => {
  const left = await leftover(pg.db, Date.parse('2026-10-06T10:00:00+08:00'), { cards: 1 });
  const key = memberKey(left.subject);
  expect(await usedOn(pg.db, key, '2026-10-06')).toBe(1);

  const { result, finalizer } = await sweepAfter(left.lockMs);
  expect(result).toMatchObject({ processed: 1, finalized: 1, failed: 0 });
  expect(finalizer.calls[0]?.outcome).toMatchObject({
    kind: 'final',
    frame: RECOVERED,
    refunded: false,
  });
  const row = await runRow(pg.db, left.runId);
  expect(row).toMatchObject({
    end_reason: 'server_error',
    settle_result: 'counted',
    card_delivered: true,
  });
  expect(row['final_event']).toEqual(stored(RECOVERED));
  expect((await sessionRow(pg.db, left.sessionId))['run_lock_run_id']).toBeNull();
  expect(await usedOn(pg.db, key, '2026-10-06')).toBe(1);
});

it('[AC-B3-03e#7] 已有取消记录（cancel_requested_at 非空）的遗留 run：一轮收尾按 cancelled 结束、done(finish_reason=cancelled)、照常计数、锁释放（以落库为准）', async () => {
  const left = await leftover(pg.db, Date.parse('2026-10-06T10:00:00+08:00'), { cancel: true });
  expect((await runRow(pg.db, left.runId))['cancel_requested_at']).not.toBeNull();
  const key = memberKey(left.subject);

  const { result, finalizer } = await sweepAfter(left.lockMs);
  expect(result).toMatchObject({ processed: 1, finalized: 1, failed: 0 });
  expect(finalizer.calls[0]?.outcome).toMatchObject({
    kind: 'final',
    frame: { event: 'done', data: { finish_reason: 'cancelled' } },
    refunded: false,
  });
  const row = await runRow(pg.db, left.runId);
  expect(row).toMatchObject({ end_reason: 'cancelled', settle_result: 'counted' });
  expect(row['final_event']).toMatchObject({ type: 'done', data: { finish_reason: 'cancelled' } });
  expect((await sessionRow(pg.db, left.sessionId))['run_lock_run_id']).toBeNull();
  expect(await usedOn(pg.db, key, '2026-10-06')).toBe(1);
});

it('[AC-B3-03e#21] 已有终止原因未结算的遗留 run（活进程 S4 已提交 end_reason，未 settle / finish 即崩溃，锁已过期、无 hold）：一轮被发现并按已落库的原因收尾（不改成 server_error）、写终态、释放锁；timeout 未出卡退 1 条，consent_withdrawn 未出卡与 stop 出卡照常计数；再扫不重复结算', async () => {
  // Expected refunds per BR-AI-15 退还 (20 s timeout without any card → refunded; withdrawn
  // consent never refunded, BR-AI-13; a normal stop with a card counts).
  const table = [
    { ending: 'timeout', cards: 0, refunded: true },
    { ending: 'consent_withdrawn', cards: 0, refunded: false },
    { ending: 'stop', cards: 1, refunded: false },
  ] as const;
  for (const [i, { ending, cards, refunded }] of table.entries()) {
    const label = `${ending}/${String(cards)}`;
    expect(shouldRefund({ ending, cardsDelivered: cards }), label).toBe(refunded);
    const left = await leftover(pg.db, Date.parse('2026-10-06T10:00:00+08:00') + i * 100_000, {
      ending,
      cards,
    });
    const before = await runRow(pg.db, left.runId);
    expect(before, label).toMatchObject({
      end_reason: ending,
      final_event: null,
      settle_result: null,
      finalize_hold: null,
      card_delivered: cards > 0,
    });
    expect((await sessionRow(pg.db, left.sessionId))['run_lock_run_id'], label).toBe(left.runId);
    const key = memberKey(left.subject);
    expect(await usedOn(pg.db, key, '2026-10-06'), label).toBe(1);

    const { result, finalizer, nowMs } = await sweepAfter(left.lockMs);
    expect(finalizer.runIds, label).toEqual([left.runId]);
    expect(result, label).toMatchObject({ processed: 1, finalized: 1, failed: 0 });
    expect(finalizer.calls[0]?.outcome, label).toMatchObject({
      kind: 'final',
      refunded,
      wrote: true,
    });
    const row = await runRow(pg.db, left.runId);
    expect(row, label).toMatchObject({
      end_reason: ending,
      settle_result: refunded ? 'refunded' : 'counted',
      card_delivered: cards > 0,
    });
    expect(row['final_event'], label).toMatchObject(stored(draftOf(ending)));
    expect(row['final_event'], label).not.toEqual(stored(RECOVERED));
    expect(await sessionRow(pg.db, left.sessionId), label).toMatchObject({
      run_lock_run_id: null,
      run_lock_expires_at: null,
    });
    expect(await usedOn(pg.db, key, '2026-10-06'), label).toBe(refunded ? 0 : 1);

    const settledRow = await runRow(pg.db, left.runId);
    const again = at(nowMs + 3_600_000);
    const recheck = new RecordingFinalizer(instance(pg.db, { clock: again }).ports.finalizer);
    const second = await sweeper(pg.db, recheck, again, sweeperDefaults()).sweepOnce(sweepStart());
    expect(second, label).toMatchObject({ processed: 0, wrapped: true });
    expect(recheck.calls, label).toHaveLength(0);
    expect(await runRow(pg.db, left.runId), label).toEqual(settledRow);
    expect(await usedOn(pg.db, key, '2026-10-06'), label).toBe(refunded ? 0 : 1);
  }
});
