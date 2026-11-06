// B2-12f approval (claude-independent): BR-FUND-12「批准时重读 available 与 frozen…available <0 → 写
// BAD_DEBT_WRITEOFF（借 BAD_DEBT / 贷 USER_BALANCE.available，金额 = −当前 available_fen，不用候选单生成时的
// 金额），使 available=0；≥0 → 候选单置 CANCELLED，不写凭证。凭证 uniq_key=BADDEBT:{account_id}:{candidate_id}」
// with its 例 (−800 生成，批准前入账 500 → 核销 300), state machine BD2 / BD3, BR-FUND-16 (分录借贷平衡、
// 会计日取注入时钟), the contract's effects (one transaction under the member's balance lock; the
// audit record bad_debt_writeoff_approve with the id, the account_id, the resulting status,
// written_off_fen and available before and after, no personal data; CANCELLED answers 200 with
// written_off_fen 0 and approver_id / approved_at null). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  APPROVE_ACTION,
  SINCE,
  answer,
  audits,
  creditOn,
  credit,
  everything,
  expectApproveAudit,
  expectCancelled,
  expectWrittenOff,
  fixture,
  holdMember,
  moneyOf,
  negativeMember,
  newKey,
  seedCandidate,
  suite,
  track,
  waiting,
  withWriteoffAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-12f#15] BR-FUND-12 例：候选单生成时 −800（candidate_fen 800），批准前入账 500 → 批准核销 300（不是 800）：应答 APPROVED、written_off_fen 300、available 0；凭证 BADDEBT:{account_id}:{id} 记在当天会计日，分录逐行对 BAD_DEBT_WRITEOFF 模板（借 BAD_DEBT 300 / 贷 USER_BALANCE.available 300）且借贷合计为 0；negative_since 清空；审计 bad_debt_writeoff_approve 一条，含单号、账户、APPROVED、300 与前后 available −300 / 0，不含个人信息', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    expect(row).toMatchObject({ candidate_fen: 800n, negative_since: SINCE, status: 'PENDING' });
    await credit(f, m, 500n);
    expect(await moneyOf(f, m)).toEqual({ available: -300n, frozen: 0n, negativeSince: SINCE });

    const done = await expectWrittenOff(f, await h.approve(row.id), {
      row,
      m,
      adminId: h.writer.id,
      amount: 300n,
      frozen: 0n,
    });
    expect(done.candidate_fen, '候选单金额只作参考、不改').toBe(800n);
    await expectApproveAudit(f, {
      adminId: h.writer.id,
      row,
      status: 'APPROVED',
      writtenOff: 300n,
      before: -300n,
      after: 0n,
    });
  });
});

it('[AC-B2-12f#16] 批准在会员的锁下重读余额：外部事务先持有 users 行与余额行，批准请求排队等锁；外部事务在锁内入账 500（−800 → −300）后提交，批准按锁后读到的 −300 核销 300', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const hold = await holdMember(f, m.userId, async (trx, balance) => {
      await creditOn(f, trx, balance, 500n);
    });
    const pending = track(h.approve(row.id));
    try {
      expect(await waiting(f, 1, [pending]), '批准应等会员的锁').toBe(true);
    } finally {
      await hold.release();
    }
    await expectWrittenOff(f, await pending.promise, {
      row,
      m,
      adminId: h.writer.id,
      amount: 300n,
      frozen: 0n,
    });
  });
});

it('[AC-B2-12f#17] 批准时余额已回正 → CANCELLED、HTTP 200、written_off_fen 0：正好抵平到 0 的、回到 +200 的都不写凭证、不动余额，approver_id 与 approved_at 仍为 null；各写一条审计（CANCELLED、0、前后 available 相同）', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const even = await negativeMember(f, { available: -800n, since: SINCE });
    const evenRow = await seedCandidate(f, even);
    await credit(f, even, 800n);
    const above = await negativeMember(f, { available: -800n, since: SINCE });
    const aboveRow = await seedCandidate(f, above);
    await credit(f, above, 1000n);

    await expectCancelled(f, await h.approve(evenRow.id), {
      row: evenRow,
      m: even,
      money: { available: 0n, frozen: 0n, negativeSince: null },
    });
    await expectApproveAudit(f, {
      adminId: h.writer.id,
      row: evenRow,
      status: 'CANCELLED',
      writtenOff: 0n,
      before: 0n,
      after: 0n,
    });

    const before = await audits(f, APPROVE_ACTION);
    await expectCancelled(f, await h.approve(aboveRow.id), {
      row: aboveRow,
      m: above,
      money: { available: 200n, frozen: 0n, negativeSince: null },
    });
    const after = await audits(f, APPROVE_ACTION);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    const text = JSON.stringify([after.at(-1)!.target, after.at(-1)!.before, after.at(-1)!.after]);
    for (const part of [aboveRow.id, aboveRow.account_id, 'CANCELLED', '200']) {
      expect(text, part).toContain(part);
    }
  });
});

it('[AC-B2-12f#18] 一个事务：写审计失败或改候选单失败时整笔回滚（候选单仍 PENDING、无凭证、余额与 negative_since 不变、无审计），换新幂等键重试一次生效', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const before = await everything(f);
    for (const point of ['audit', 'candidate'] as const) {
      h.fault.point = point;
      const tripped = h.fault.tripped;
      const failed = await h.approve(row.id, {}, { key: newKey() });
      expect(h.fault.tripped, `${point} 故障应被触发`).toBe(tripped + 1);
      await answer(failed, 50001);
      expect(await everything(f), `${point} 失败整笔回滚`).toEqual(before);
    }
    await expectWrittenOff(f, await h.approve(row.id, {}, { key: newKey() }), {
      row,
      m,
      adminId: h.writer.id,
      amount: 800n,
      frozen: 0n,
    });
    expect((await moneyOf(f, m)).negativeSince).toBeNull();
  });
});
