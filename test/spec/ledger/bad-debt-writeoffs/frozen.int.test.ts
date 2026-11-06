// B2-12f frozen money at approval (claude-independent): BR-FUND-12「该用户 frozen_fen 大于 0（有非终态提现单）
// 时拒绝批准，候选单保持 PENDING，提示先把提现单处理到终态（决-11 选 A；开关
// ledger.bad_debt_require_no_frozen.enabled，默认 on，off 时不看 frozen 照常核销）」with its 例（有卡住的提现单，
// E-35：available −1000、frozen 1000 → 拒绝；驳回该单退回 1000、available 0 → 下次批准置 CANCELLED）, the contract
// (20001 data.fields=[id] data.reason=writeoff_frozen_pending, nothing written; approve_blocked in the
// list), and the production ledger of the admin entry (D10-587): the write-off that brings available
// back to 0 runs payout's recovery hook, so the NEGATIVE_BALANCE block of the member's withdrawal is
// lifted in the same transaction. The switch is stored before the entry starts (content caches its
// reads). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  DAY,
  NO_FROZEN_KEY,
  SINCE,
  configure,
  everything,
  expectCancelled,
  expectWrittenOff,
  fixture,
  frozenPending,
  moneyOf,
  negativeMember,
  pageOf,
  returnFrozen,
  rowView,
  seedCandidate,
  suite,
  withWriteoffAdmin,
  withdrawalNow,
} from './kit.ts';

const s = suite();

it('[AC-B2-12f#19] 开关 on、有冻结中的提现（available −1000、frozen 1000）→ 20001 writeoff_frozen_pending，不写凭证、单保持 PENDING、余额不动，列表 approve_blocked=true；提现单驳回退回 1000（available 0、frozen 0）后再批准 → CANCELLED、200、written_off_fen 0，没有坏账', async () => {
  const f = fixture(s);
  await configure(f, NO_FROZEN_KEY, true);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -1000n, since: SINCE, frozen: 1000n });
    expect(await moneyOf(f, m)).toEqual({ available: -1000n, frozen: 1000n, negativeSince: SINCE });
    const row = await seedCandidate(f, m);
    const before = await everything(f);

    await frozenPending(await h.approve(row.id));
    await frozenPending(await h.approve(row.id));
    expect(await everything(f), '拒绝不留痕，单仍 PENDING').toEqual(before);
    const listed = await pageOf(await h.list({ status: 'PENDING' }));
    expect(listed.items).toEqual([
      rowView(row, m, { available: -1000n, frozen: 1000n }, { day: DAY, blocked: true }),
    ]);

    await returnFrozen(f, m, 1000n);
    expect(await moneyOf(f, m)).toEqual({ available: 0n, frozen: 0n, negativeSince: null });
    await expectCancelled(f, await h.approve(row.id), {
      row,
      m,
      money: { available: 0n, frozen: 0n, negativeSince: null },
    });
  });
});

it('[AC-B2-12f#20] 开关没有配置行时按默认 on：frozen 500 > 0 → 20001 writeoff_frozen_pending，什么都不写，列表 approve_blocked=true', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -700n, since: SINCE, frozen: 500n });
    const row = await seedCandidate(f, m);
    const before = await everything(f);
    await frozenPending(await h.approve(row.id));
    expect(await everything(f)).toEqual(before);
    const listed = await pageOf(await h.list({}));
    expect(listed.items).toEqual([
      rowView(row, m, { available: -700n, frozen: 500n }, { day: DAY, blocked: true }),
    ]);
  });
});

it('[AC-B2-12f#21] 开关 off：不看 frozen，列表 approve_blocked=false；available −1500、frozen 1000（NEGATIVE_BALANCE 拦截的已批提现单）照常核销 1500，available 0、frozen 仍 1000；同一笔经回正钩子解除该单拦截（blocked_reason 清空、updated_at 取时钟、row_version + 1、状态不变）', async () => {
  const f = fixture(s);
  await configure(f, NO_FROZEN_KEY, false);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, {
      available: -1500n,
      since: SINCE,
      frozen: 1000n,
      blocked: true,
    });
    const row = await seedCandidate(f, m);
    const listed = await pageOf(await h.list({}));
    expect(listed.items).toEqual([
      rowView(row, m, { available: -1500n, frozen: 1000n }, { day: DAY, blocked: false }),
    ]);
    const withdrawal = await withdrawalNow(f, m.withdrawalId!);
    expect(withdrawal.blocked_reason).toBe('NEGATIVE_BALANCE');

    await expectWrittenOff(f, await h.approve(row.id), {
      row,
      m,
      adminId: h.writer.id,
      amount: 1500n,
      frozen: 1000n,
    });
    expect(await withdrawalNow(f, m.withdrawalId!)).toEqual({
      ...withdrawal,
      blocked_reason: null,
      updated_at: f.clock.now(),
      row_version: withdrawal.row_version + 1,
    });
  });
});
