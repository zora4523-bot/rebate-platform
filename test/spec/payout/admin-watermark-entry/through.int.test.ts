// B2-09i end-to-end rule tests (claude-independent, SPEC_REF 6f50a051): the purpose of the task — W
// entered through POST /admin/v1/payout-watermarks is the W that B2-06c's real createPayoutExecute
// judges. 08 BR-WDR-18 ①②③ and its examples: no row or a reading older than 2 hours → stale (exactly
// 2 hours still passes), W < P → below forecast, Σ > 90% of W → usable exceeded; the latest row by
// measured_at decides. W never comes from a seeded row here except the older rows of #5. Amounts are
// fen, written by hand. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  HOUR,
  MINUTE,
  books,
  enterBody,
  entered,
  executeAuto,
  executedOf,
  fixture,
  member,
  probeAuto,
  refusedFor,
  seedSevenDays,
  seedWatermark,
  seedWithdrawal,
  sorted,
  suite,
  withWatermarkAdmin,
  withdrawalRow,
} from './kit.ts';

const s = suite();

it('[AC-B2-09i#2] 贯通：同一批 APPROVED 的自动单，① 没有 W 时执行被拒 watermark_stale、单子留在 APPROVED、什么都没写；② 经接口录入足额 W 后同一批能执行；③ 恰好 2 小时仍能执行，再过 1 毫秒又被 watermark_stale 拒绝；④ 重新录入后同一批真正进入 PAYING', async () => {
  const f = fixture(s);
  const first = await seedWithdrawal(f, { userId: await member(f), net: 30_000n });
  const second = await seedWithdrawal(f, { userId: await member(f), net: 20_000n });
  const batch = [first, second];
  await withWatermarkAdmin(f, async (h) => {
    // ① 没有 W。
    const untouched = await books(f);
    expect(await executeAuto(f, batch)).toEqual(refusedFor('watermark_stale'));
    expect(await books(f)).toEqual(untouched);
    for (const id of batch) expect((await withdrawalRow(f, id)).status).toBe('APPROVED');
    expect(f.send).not.toHaveBeenCalled();

    // ② 经接口录入 W=¥10,000（10:00 取数），同一批通过判定。
    await entered(
      await h.enter(
        enterBody({ available_fen: 1_000_000, measured_at: '2026-11-03T10:00:00+08:00' }),
      ),
    );
    const passed = await probeAuto(f, batch);
    expect(sorted(executedOf(passed.result).paying)).toEqual(sorted(batch));
    expect(executedOf(passed.result).left).toEqual([]);
    expect(passed.statuses).toEqual(['PAYING', 'PAYING']);
    expect(await books(f)).toEqual(untouched);

    // ③ 恰好 2 小时还算新鲜，再过 1 毫秒就过期。
    f.clock.advanceMs(2 * HOUR);
    expect(sorted(executedOf((await probeAuto(f, batch)).result).paying)).toEqual(sorted(batch));
    f.clock.advanceMs(1);
    expect(await executeAuto(f, batch)).toEqual(refusedFor('watermark_stale'));
    expect(await books(f)).toEqual(untouched);
    for (const id of batch) expect((await withdrawalRow(f, id)).status).toBe('APPROVED');
    expect(f.send).not.toHaveBeenCalled();

    // ④ 重新录入，同一批提交后进入 PAYING。
    const caller = await h.relogin(h.operator);
    await entered(
      await h.enter(
        enterBody({ available_fen: 1_000_000, measured_at: '2026-11-03T12:00:00.001+08:00' }),
        { caller },
      ),
    );
    const done = executedOf(await executeAuto(f, batch));
    expect(sorted(done.paying)).toEqual(sorted(batch));
    expect(done.left).toEqual([]);
    for (const id of batch) {
      expect(await withdrawalRow(f, id)).toMatchObject({
        status: 'PAYING',
        execute_seq: 1,
        executor_id: null,
        batch_id: done.batchId,
        executed_at: f.clock.now(),
      });
    }
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(
      await f.db
        .selectFrom('payout_batches')
        .select(['id', 'kind', 'created_by'])
        .where('app_id', '=', f.appId)
        .execute(),
    ).toEqual([{ id: done.batchId, kind: 'auto', created_by: null }]);
  });
});

it('[AC-B2-09i#3] BR-WDR-18 例：近 7 日申请合计 ¥49,000、P=¥21,000。录入 W=¥20,000 → watermark_below_forecast，单子不动；录入 W=¥30,000（低于告警线 1.5P=¥31,500 但不低于 P）→ 不因 W < P 被拒，能执行', async () => {
  const f = fixture(s);
  await seedSevenDays(f);
  const id = await seedWithdrawal(f, { userId: await member(f), net: 10_000n });
  await withWatermarkAdmin(f, async (h) => {
    await entered(
      await h.enter(
        enterBody({ available_fen: 2_000_000, measured_at: '2026-11-03T09:30:00+08:00' }),
      ),
    );
    expect(await executeAuto(f, [id])).toEqual(refusedFor('watermark_below_forecast'));
    expect((await withdrawalRow(f, id)).status).toBe('APPROVED');

    await entered(
      await h.enter(
        enterBody({ available_fen: 3_000_000, measured_at: '2026-11-03T09:40:00+08:00' }),
      ),
    );
    expect(executedOf(await executeAuto(f, [id])).paying).toEqual([id]);
    expect((await withdrawalRow(f, id)).status).toBe('PAYING');
  });
});

it('[AC-B2-09i#4] BR-WDR-18 例：录入 W=¥40,000、P=¥21,000、PAYING 合计 ¥8,000、取数后已到账 ¥2,000：本批 ¥27,000 → 37,000 > 36,000 → watermark_usable_exceeded；本批 ¥26,000 → 恰好 36,000 能执行（取数时刻 t_W 取录入的 measured_at）', async () => {
  const f = fixture(s);
  await seedSevenDays(f);
  const owner = await member(f);
  await seedWithdrawal(f, { userId: owner, net: 800_000n, status: 'PAYING' });
  await seedWithdrawal(f, {
    userId: owner,
    net: 200_000n,
    status: 'PAID_API',
    paidAt: new Date(f.clock.now().getTime() - 30 * MINUTE),
  });
  // 取数之前到账的不计入：t_W 读错成别的时刻时这一笔会改变结果。
  await seedWithdrawal(f, {
    userId: owner,
    net: 900_000n,
    status: 'PAID_API',
    paidAt: new Date(f.clock.now().getTime() - 90 * MINUTE),
  });
  const tooMuch = await seedWithdrawal(f, { userId: await member(f), net: 2_700_000n });
  const enough = await seedWithdrawal(f, { userId: await member(f), net: 2_600_000n });
  await withWatermarkAdmin(f, async (h) => {
    await entered(
      await h.enter(
        enterBody({ available_fen: 4_000_000, measured_at: '2026-11-03T09:00:00+08:00' }),
      ),
    );
    expect(await executeAuto(f, [tooMuch])).toEqual(refusedFor('watermark_usable_exceeded'));
    expect((await withdrawalRow(f, tooMuch)).status).toBe('APPROVED');
    expect(executedOf(await executeAuto(f, [enough])).paying).toEqual([enough]);
  });
});

it('[AC-B2-09i#5] 判定取 measured_at 最新的一行：旧行 W 不够、新录入够 → 能执行；再录入更新的一条 W 不够 → 拒绝，旧行都不再起作用', async () => {
  const f = fixture(s);
  await seedWatermark(f, { availableFen: 1n, measuredAt: '2026-11-03T09:00:00+08:00' });
  const a = await seedWithdrawal(f, { userId: await member(f), net: 100_000n });
  const b = await seedWithdrawal(f, { userId: await member(f), net: 100_000n });
  await withWatermarkAdmin(f, async (h) => {
    expect(await executeAuto(f, [a])).toEqual(refusedFor('watermark_usable_exceeded'));

    await entered(
      await h.enter(
        enterBody({ available_fen: 1_000_000, measured_at: '2026-11-03T09:30:00+08:00' }),
      ),
    );
    expect(executedOf(await executeAuto(f, [a])).paying).toEqual([a]);

    await entered(
      await h.enter(enterBody({ available_fen: 100, measured_at: '2026-11-03T09:40:00+08:00' })),
    );
    expect(await executeAuto(f, [b])).toEqual(refusedFor('watermark_usable_exceeded'));
    expect((await withdrawalRow(f, b)).status).toBe('APPROVED');
  });
});
