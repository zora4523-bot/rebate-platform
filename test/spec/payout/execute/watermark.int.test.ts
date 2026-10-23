// B2-06c ③ the watermark check of EXECUTE (规划/08 BR-WDR-18 ①②③, BR-WDR-12 ③, D10-223 水位表):
// W = the latest payout_watermarks row of (app, channel) by measured_at; stale when missing or older
// than 2 hours (exactly 2 hours passes); P = round_half_up(7-day total / 7) × 3 over the 7 complete
// natural days (+08:00) before today, REJECTED excluded; Σ batch + Σ PAYING + Σ paid after t_W must
// not exceed W × usable_bp / 10000 (equality passes). Per channel; any failure refuses the whole
// batch atomically. Expected values are computed here by hand.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  HOUR,
  MINUTE,
  NOW,
  TIMEOUT,
  close,
  executed,
  expectPaying,
  open,
  setup,
  snapshot,
  sorted,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const ago = (ms: number) => new Date(NOW.getTime() - ms);

it('[AC-B2-06c#3] ③ 该通道没有水位记录：整批拒绝 watermark_stale，零迁移零明细零任务', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  const a = await f.seedWithdrawal();
  const b = await f.seedWithdrawal({ net: 50n });
  const before = await snapshot(f);
  expect(await f.run(service, [a, b])).toEqual({
    kind: 'rejected',
    reason: 'watermark_stale',
    channel: 'alipay',
  });
  expect(await snapshot(f)).toEqual(before);
  expect(f.send).not.toHaveBeenCalled();
});

it.each([
  ['恰好 2 小时', 2 * HOUR, 'executed'],
  ['2 小时又 1 毫秒', 2 * HOUR + 1, 'watermark_stale'],
] as const)('[AC-B2-06c#3] ③ t_W 距今%s → %s', async (_name, age, outcome) => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(1_000_000n, ago(age), 'alipay');
  const id = await f.seedWithdrawal();
  const before = await snapshot(f);
  const result = await f.run(service, [id]);
  if (outcome === 'executed') {
    const answer = executed(result);
    expect(answer.paying).toEqual([id]);
    await expectPaying(f, id, { batchId: answer.batchId, seq: 1, executor: f.adminId });
  } else {
    expect(result).toEqual({ kind: 'rejected', reason: outcome, channel: 'alipay' });
    expect(await snapshot(f)).toEqual(before);
  }
});

it('[AC-B2-06c#3] ③ W 取该 app、该通道 measured_at 最新的一行（不看录入先后、别的通道与别的 app）', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(50n, ago(30 * MINUTE), 'alipay');
  // Entered later, measured earlier: not the latest reading.
  await f.watermark(1_000_000_000n, ago(HOUR), 'alipay');
  await f.watermark(1_000_000_000n, ago(MINUTE), 'bank_card');
  await f.watermark(1_000_000_000n, ago(MINUTE), 'alipay', `other_${f.appId}`);
  const id = await f.seedWithdrawal({ net: 100n });
  const before = await snapshot(f);
  // usable = 50 × 10000 / 10000 = 50 < 100.
  expect(await f.run(service, [id])).toEqual({
    kind: 'rejected',
    reason: 'watermark_usable_exceeded',
    channel: 'alipay',
  });
  expect(await snapshot(f)).toEqual(before);
});

it.each([
  [3003n, 'executed'],
  [3002n, 'watermark_below_forecast'],
] as const)(
  '[AC-B2-06c#3] ③ P = round_half_up(近 7 个完整自然日申请合计 7004 / 7) × 3 = 3003；W=%s → %s',
  async (w, outcome) => {
    const f = await setup(h, { watermarks: false });
    const service = f.execute();
    const o = await f.newUser();
    const at = (iso: string) => new Date(iso);
    const plusMinute = (iso: string) => new Date(at(iso).getTime() + MINUTE);
    // Window [2026-10-12 00:00 +08:00, 2026-10-19 00:00 +08:00) = [10-11T16:00Z, 10-18T16:00Z).
    const inside = [
      { net: 4000n, status: 'PAID_API', createdAt: '2026-10-11T16:00:00.000Z' },
      { net: 3000n, status: 'FAILED', createdAt: '2026-10-15T03:00:00.000Z' },
      { net: 4n, status: 'PENDING_REVIEW', createdAt: '2026-10-18T15:59:59.999Z' },
    ] as const;
    const outside = [
      { net: 7000n, status: 'REJECTED', createdAt: '2026-10-14T03:00:00.000Z' },
      { net: 7000n, status: 'PAID_API', createdAt: '2026-10-11T15:59:59.999Z' },
      { net: 7000n, status: 'PAID_API', createdAt: '2026-10-18T16:00:00.000Z' },
    ] as const;
    for (const row of [...inside, ...outside]) {
      await f.seedWithdrawal({
        userId: o,
        net: row.net,
        status: row.status,
        createdAt: at(row.createdAt),
        paidAt: plusMinute(row.createdAt),
      });
    }
    const otherApp = `other_${f.appId}`;
    await f.seedWithdrawal({
      appId: otherApp,
      userId: await f.newUser(0n, otherApp),
      net: 7000n,
      status: 'APPROVED',
      createdAt: at('2026-10-15T03:00:00.000Z'),
    });
    await f.watermark(w, ago(10 * MINUTE), 'alipay');
    const id = await f.seedWithdrawal({ net: 100n });
    const before = await snapshot(f);
    const result = await f.run(service, [id]);
    if (outcome === 'executed') {
      expect(executed(result).paying).toEqual([id]);
    } else {
      expect(result).toEqual({ kind: 'rejected', reason: outcome, channel: 'alipay' });
      expect(await snapshot(f)).toEqual(before);
    }
  },
);

it.each([
  [2500n, 'executed'],
  [2501n, 'watermark_usable_exceeded'],
] as const)(
  '[AC-B2-06c#3] ③ Σ 本批(3000+%s) + Σ PAYING(2000) + Σ t_W 后到账(1000+500) 对 W×9000/10000=9000 → %s',
  async (second, outcome) => {
    const f = await setup(h, { watermarks: false });
    const service = f.execute();
    await f.set('payout.watermark_usable_bp', 9000);
    const tW = ago(HOUR);
    await f.watermark(10000n, tW, 'alipay');
    const o = await f.newUser();
    const earlier = ago(3 * HOUR);
    // Counted: PAYING, and PAID_API / PAID_MANUAL paid after t_W.
    await f.seedWithdrawal({ userId: o, net: 2000n, status: 'PAYING', createdAt: earlier });
    await f.seedWithdrawal({
      userId: o,
      net: 1000n,
      status: 'PAID_API',
      createdAt: earlier,
      paidAt: ago(30 * MINUTE),
    });
    await f.seedWithdrawal({
      userId: o,
      net: 500n,
      status: 'PAID_MANUAL',
      createdAt: earlier,
      paidAt: ago(20 * MINUTE),
    });
    // Not counted: paid before t_W, other states, another app.
    await f.seedWithdrawal({
      userId: o,
      net: 50000n,
      status: 'PAID_API',
      createdAt: earlier,
      paidAt: ago(2 * HOUR),
    });
    await f.seedWithdrawal({ userId: o, net: 7777n, status: 'APPROVED', createdAt: earlier });
    await f.seedWithdrawal({ userId: o, net: 9999n, status: 'FAILED', createdAt: earlier });
    await f.seedWithdrawal({ userId: o, net: 9999n, status: 'REJECTED', createdAt: earlier });
    await f.seedWithdrawal({ userId: o, net: 9999n, status: 'PENDING_REVIEW', createdAt: earlier });
    const otherApp = `other_${f.appId}`;
    const stranger = await f.newUser(0n, otherApp);
    await f.seedWithdrawal({
      appId: otherApp,
      userId: stranger,
      net: 50000n,
      status: 'PAYING',
      createdAt: earlier,
    });
    await f.seedWithdrawal({
      appId: otherApp,
      userId: stranger,
      net: 50000n,
      status: 'PAID_API',
      createdAt: earlier,
      paidAt: ago(10 * MINUTE),
    });
    const a = await f.seedWithdrawal({ net: 3000n });
    const b = await f.seedWithdrawal({ net: second });
    const before = await snapshot(f);
    const result = await f.run(service, [a, b]);
    if (outcome === 'executed') {
      expect(sorted(executed(result).paying)).toEqual(sorted([a, b]));
    } else {
      expect(result).toEqual({ kind: 'rejected', reason: outcome, channel: 'alipay' });
      expect(await snapshot(f)).toEqual(before);
    }
  },
);

it('[AC-B2-06c#3] ③ 只对可执行集合求和：② 留下的单不计入本批合计', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(1000n, ago(10 * MINUTE), 'alipay');
  const frozen = await f.newUser();
  f.risk.set(frozen, { state: 'frozen', frozen_until: null });
  const good = await f.seedWithdrawal({ net: 1000n });
  const blocked = await f.seedWithdrawal({ userId: frozen, net: 500n });
  const answer = executed(await f.run(service, [good, blocked]));
  expect(answer.paying).toEqual([good]);
  expect(answer.left).toEqual([{ id: blocked, reason: 'member_blocked' }]);
});

it('[AC-B2-06c#3] ③ 按通道分别计算：两个通道各自 W=100、各一单 100 都通过', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(100n, ago(10 * MINUTE), 'alipay');
  await f.watermark(100n, ago(10 * MINUTE), 'bank_card');
  const a = await f.seedWithdrawal({ net: 100n, channel: 'alipay' });
  const b = await f.seedWithdrawal({ net: 100n, channel: 'bank_card', userId: await f.newUser() });
  const answer = executed(await f.run(service, [a, b]));
  expect(sorted(answer.paying)).toEqual(sorted([a, b]));
  await expectPaying(f, a, { batchId: answer.batchId, seq: 1, executor: f.adminId });
  await expectPaying(f, b, { batchId: answer.batchId, seq: 1, executor: f.adminId });
});

it('[AC-B2-06c#3] ③ 任一通道不满足即整批拒绝并指明通道，另一通道的单也不迁移、② 的原因也不写明细', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(1_000_000_000n, ago(10 * MINUTE), 'alipay');
  await f.watermark(1_000_000_000n, ago(3 * HOUR), 'bank_card');
  const a = await f.seedWithdrawal({ channel: 'alipay' });
  const b = await f.seedWithdrawal({ channel: 'bank_card', userId: await f.newUser() });
  const paying = await f.seedWithdrawal({ status: 'PAYING', userId: await f.newUser() });
  const before = await snapshot(f);
  expect(await f.run(service, [a, b, paying])).toEqual({
    kind: 'rejected',
    reason: 'watermark_stale',
    channel: 'bank_card',
  });
  expect(await snapshot(f)).toEqual(before);
  expect(f.send).not.toHaveBeenCalled();
});
