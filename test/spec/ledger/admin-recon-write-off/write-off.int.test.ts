// B2-07e write-off rule tests, the effects (claude-independent, SPEC_REF 37808a50):
// contracts/openapi.yaml writeOffAdminReconDiff — in one transaction the withdrawal APPROVED →
// PAID_API (paid_at the bill line's time when it carries one, else the server's time;
// channel_order_id from the bill line; the payer-side hold cleared; the operator the executor) and
// the success voucher `wd:{id}:PAID` (BR-WDR-09) against frozen; the difference written_off
// (handler the caller, closed_at = updated_at = the server clock, resolution keeps its keys and
// adds w11 { withdrawal_id, paid_at, operator } and the trimmed note when given); every unreleased
// hold whose source is the difference released (released_hold_count; holds released earlier and
// holds of other sources untouched; released by admin:<id>, task §9.2); the audit
// recon_diff_write_off (statuses before / after, withdrawal_id, released_hold_count, no personal
// data); wallet.withdrawal_changed; the attempt-append job queued on the same transaction
// (D10-428). The response is the detail as GET returns it, the withdrawal's four fields and
// released_hold_count. The frozen invariant holds before and after. The W11 guard counts only
// kind=transfer: query rows after the failed transfer do not stop the write-off and stay as they
// were.
// Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  BOOKED_AT_MS,
  BODY,
  DETAIL_KEYS,
  PAYEE_NAME,
  WRITE_OFF_ACTION,
  allHolds,
  answer,
  attemptJobs,
  attemptRows,
  audits,
  balanceOf,
  changes,
  channelOrderOf,
  detailView,
  entries,
  expectWrittenOff,
  fixture,
  frozenMismatches,
  holdNow,
  normalize,
  paidEntries,
  paidView,
  returnedResolution,
  seedCase,
  seedHold,
  seedReturnedDiff,
  seedWithdrawal,
  sourceOf,
  suite,
  voucherOf,
  withWriteOffAdmin,
  withdrawalRow,
  withdrawalVouchers,
  writtenOff,
} from './kit.ts';

const s = suite();

it('[AC-B2-07e#17] 核销（payout.execute + totp 二次验证）：提现单 APPROVED → PAID_API（paid_at 取账单行入账时间、channel_order_id 取账单行、付款方侧暂停清空、executor_id 为操作人）；同一事务记 wd:{id}:PAID 一张（operator admin:<id>，自 frozen 出）；差错单 written_off、resolution 保留原键并加 w11 与去空白的 note；应答为核销后的详情、提现单四个字段与 released_hold_count', async () => {
  const f = fixture(s);
  const c = await seedCase(f, { withdrawal: { net: 1000n, fee: 30n, tax: 20n } });
  const before = await withdrawalRow(f.db, f.appId, c.w.id);
  const balance = await balanceOf(f.db, f.ledger, f.appId, c.userId);
  expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  await withWriteOffAdmin(f, async (h) => {
    const note = '  支付宝账单 2026-10-28 显示该笔已到账，按账单行核销\t\n';
    const sent = await h.writeOff(c.diff.id, { ...BODY, note });
    const data = await writtenOff(sent);

    const after = await expectWrittenOff(f, c.diff, {
      adminId: h.executor.id,
      withdrawalId: c.w.id,
      paidAtMs: BOOKED_AT_MS,
      note: note.trim(),
    });
    expect(Object.keys(data.recon_diff).sort(), sent.body).toEqual(DETAIL_KEYS);
    expect(data.recon_diff, sent.body).toEqual(detailView(after));
    expect(data.withdrawal, sent.body).toEqual(paidView(c.w, BOOKED_AT_MS));
    expect(data.released_hold_count, sent.body).toBe(1);
    expect(await withdrawalRow(f.db, f.appId, c.w.id)).toEqual({
      ...before,
      status: 'PAID_API',
      paid_at: new Date(BOOKED_AT_MS),
      channel_order_id: channelOrderOf(c.w),
      hold_reason: null,
      hold_at: null,
      executor_id: h.executor.id,
      executed_at: f.clock.now(),
      row_version: before.row_version + 1,
      updated_at: f.clock.now(),
    });
    expect((await withdrawalVouchers(f.db, f.appId)).sort()).toEqual(
      [`wd:${c.w.id}:FREEZE`, `wd:${c.w.id}:PAID`].sort(),
    );
    expect(await entries(f.db, f.appId, `wd:${c.w.id}:PAID`)).toEqual(paidEntries(c.w));
    expect(await voucherOf(f.db, f.appId, `wd:${c.w.id}:PAID`)).toEqual([
      {
        uniq_key: `wd:${c.w.id}:PAID`,
        biz_type: 'withdrawal',
        biz_id: c.w.id,
        operator: `admin:${h.executor.id}`,
      },
    ]);
    expect(await balanceOf(f.db, f.ledger, f.appId, c.userId)).toEqual({
      available_fen: balance.available_fen,
      frozen_fen: balance.frozen_fen - c.w.amount,
    });
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-07e#18] 解冻、审计、事件与入队：来源为该差错单且未解除的冻结逐条解除（released_by admin:<id>、released_at 为服务端时间），早已解除的与别的来源的不动、不计数；审计 recon_diff_write_off 恰一条（前后状态、withdrawal_id、released_hold_count，无个人信息）；wallet.withdrawal_changed（PAID_API）恰一次；payout-attempt-append 任务恰一条（载荷含 app_id、withdrawal_id、recon_diff_id）', async () => {
  const f = fixture(s);
  const c = await seedCase(f);
  const second = await seedHold(f, {
    user_id: c.userId,
    reason: 'recon_diff',
    source_ref: sourceOf(c.diff.id),
    created_by: 'system:payout-recon',
  });
  const earlier = await seedHold(f, {
    user_id: c.userId,
    reason: 'recon_diff',
    source_ref: sourceOf(c.diff.id),
    created_by: 'system:payout-recon',
    released_at: new Date(f.clock.now().getTime() - 3_600_000),
    released_by: 'admin:someone-else',
  });
  const unrelated = await seedHold(f, {
    user_id: c.userId,
    reason: 'manual',
    source_ref: sourceOf(randomUUID()),
    created_by: 'admin:synthetic',
  });
  await withWriteOffAdmin(f, async (h) => {
    const data = await writtenOff(await h.writeOff(c.diff.id, BODY));
    expect(data.released_hold_count).toBe(2);

    const released = { released_at: f.clock.now(), released_by: `admin:${h.executor.id}` };
    expect(await holdNow(f, c.hold!)).toEqual({ ...c.hold!, ...released });
    expect(await holdNow(f, second)).toEqual({ ...second, ...released });
    expect(await holdNow(f, earlier)).toEqual(earlier);
    expect(await holdNow(f, unrelated)).toEqual(unrelated);

    const records = await audits(f, WRITE_OFF_ACTION);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.admin_id).toBe(h.executor.id);
    const before = JSON.stringify(record.before);
    const after = JSON.stringify(record.after);
    expect(before).toContain('"open"');
    expect(before).toContain('"APPROVED"');
    expect(after).toContain('"written_off"');
    expect(after).toContain('"PAID_API"');
    expect(`${before}${after}`).toContain(c.w.id);
    expect(after).toContain('"released_hold_count":2');
    expect(`${before}${after}`).not.toContain(PAYEE_NAME);

    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: c.w.id, user_id: c.userId, status: 'PAID_API' },
    ]);
    const jobs = await attemptJobs(f, c.w.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe('created');
    expect(jobs[0]!.data.payload).toMatchObject({
      app_id: f.appId,
      withdrawal_id: c.w.id,
      recon_diff_id: c.diff.id,
    });
    expect(JSON.stringify(jobs[0]!.data)).not.toContain(PAYEE_NAME);
    expect(await allHolds(f)).toHaveLength(4);
  });
});

it('[AC-B2-07e#19] 账单行以 bill_row 形式保存（无入账时间）→ paid_at 为服务端当前时间、channel_order_id 取 bill_row；不带 note → resolution 不加 note；处理中（processing）的差错单也能核销，原处理人被操作人替换；没有冻结时 released_hold_count 为 0；超管也能核销', async () => {
  const f = fixture(s);
  await withWriteOffAdmin(f, async (h) => {
    const c = await seedCase(f, {
      hold: false,
      diff: (w) => ({
        status: 'processing',
        handler_id: h.viewer.id,
        resolution: {
          ...returnedResolution(w, null),
          bill_row: {
            recon_channel_id: randomUUID(),
            channel_order_id: channelOrderOf(w),
            channel_status: 'SUCCESS',
            channel_amount_fen: w.net.toString(),
          },
        },
      }),
    });
    const root = await h.caller([], { superAdmin: true });
    const sent = await h.writeOff(c.diff.id, BODY, { caller: root });
    const data = await writtenOff(sent);

    const nowMs = f.clock.now().getTime();
    const after = await expectWrittenOff(f, c.diff, {
      adminId: root.id,
      withdrawalId: c.w.id,
      paidAtMs: nowMs,
    });
    expect(data.recon_diff).toEqual(detailView(after));
    expect(data.withdrawal).toEqual(paidView(c.w, nowMs));
    expect(data.released_hold_count).toBe(0);
    expect(await withdrawalRow(f.db, f.appId, c.w.id)).toMatchObject({
      status: 'PAID_API',
      paid_at: f.clock.now(),
      channel_order_id: channelOrderOf(c.w),
      hold_reason: null,
      hold_at: null,
      executor_id: root.id,
    });
  });
});

it('[AC-B2-07e#20] 同一会员两张退回单各有差错单：只核销所指的那一张，另一张单、它的差错单与冻结不动；冻结不变量前后成立', async () => {
  const f = fixture(s);
  const c = await seedCase(f, { withdrawal: { net: 1200n } });
  const userId = c.userId;
  const otherW = await seedWithdrawal(f, { userId, net: 700n });
  const otherDiff = await seedReturnedDiff(f, otherW);
  const otherHold = await seedHold(f, {
    user_id: userId,
    reason: 'recon_diff',
    source_ref: sourceOf(otherDiff.id),
    created_by: 'system:payout-recon',
  });
  const otherBefore = await withdrawalRow(f.db, f.appId, otherW.id);
  await withWriteOffAdmin(f, async (h) => {
    expect((await writtenOff(await h.writeOff(c.diff.id, BODY))).released_hold_count).toBe(1);

    expect(await withdrawalRow(f.db, f.appId, otherW.id)).toEqual(otherBefore);
    expect(
      await f.db
        .selectFrom('recon_diffs')
        .selectAll()
        .where('app_id', '=', f.appId)
        .where('id', '=', otherDiff.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(otherDiff);
    expect(await holdNow(f, otherHold)).toEqual(otherHold);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
    expect((await attemptJobs(f, otherW.id)).length).toBe(0);
    expect((await attemptJobs(f, c.w.id)).length).toBe(1);
  });
});

it('[AC-B2-07e#21] 核销后 GET 详情与应答里的 recon_diff 一致；只有 fund.recon / fund.view 的账号能读不能核销（10403）', async () => {
  const f = fixture(s);
  const c = await seedCase(f);
  await withWriteOffAdmin(f, async (h) => {
    await answer(await h.writeOff(c.diff.id, BODY, { caller: h.viewer }), 10403, {
      reason: 'admin_permission_denied',
    });
    const data = await writtenOff(await h.writeOff(c.diff.id, BODY));
    const detail = await answer(await h.detail(c.diff.id), 0);
    expect(normalize(detail.data)).toEqual(data.recon_diff);
  });
});

it('[AC-B2-07e#39] 转账失败之后还有查询记录（query unknown、query fail）：守卫只数 kind=transfer，照常核销——提现单 PAID_API、wd:{id}:PAID 一张（自 frozen 出）、差错单 written_off、解冻、attempt-append 任务一条；既有的转账与查询记录一字不改', async () => {
  const f = fixture(s);
  const cases = [
    await seedCase(f, {
      withdrawal: {
        attempts: [
          ['transfer', 'fail'],
          ['query', 'unknown'],
        ],
      },
    }),
    await seedCase(f, {
      withdrawal: {
        net: 1000n,
        fee: 30n,
        tax: 20n,
        attempts: [
          ['transfer', 'fail'],
          ['query', 'fail'],
        ],
      },
    }),
  ];
  const attemptsBefore = await Promise.all(cases.map((c) => attemptRows(f.db, f.appId, c.w.id)));
  expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  await withWriteOffAdmin(f, async (h) => {
    for (const [i, c] of cases.entries()) {
      const data = await writtenOff(await h.writeOff(c.diff.id, BODY));
      expect(data.withdrawal).toEqual(paidView(c.w, BOOKED_AT_MS));
      expect(data.released_hold_count).toBe(1);

      expect(await withdrawalRow(f.db, f.appId, c.w.id)).toMatchObject({
        status: 'PAID_API',
        paid_at: new Date(BOOKED_AT_MS),
        channel_order_id: channelOrderOf(c.w),
        hold_reason: null,
        hold_at: null,
        executor_id: h.executor.id,
      });
      expect(
        (await withdrawalVouchers(f.db, f.appId)).filter((k) => k === `wd:${c.w.id}:PAID`),
      ).toHaveLength(1);
      expect(await entries(f.db, f.appId, `wd:${c.w.id}:PAID`)).toEqual(paidEntries(c.w));
      await expectWrittenOff(f, c.diff, {
        adminId: h.executor.id,
        withdrawalId: c.w.id,
        paidAtMs: BOOKED_AT_MS,
      });
      expect(await attemptRows(f.db, f.appId, c.w.id)).toEqual(attemptsBefore[i]);
      expect(await attemptJobs(f, c.w.id)).toHaveLength(1);
    }
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});
