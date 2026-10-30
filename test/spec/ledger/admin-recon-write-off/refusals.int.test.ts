// B2-07e write-off rule tests, the refusals (claude-independent, SPEC_REF 37808a50):
// contracts/openapi.yaml writeOffAdminReconDiff — order of checks payout.execute (10403
// data.reason=admin_permission_denied; a super admin holds every point) → step-up totp (10003
// data.tier=totp) → body (expected_withdrawal_status APPROVED only; note 1–200 characters after
// trimming, else 20001 [note]) → recon_diff_id (unknown / another app / R4 / not a uuid → 20001
// [recon_diff_id], no 404) → status (closed / adjusted / written_off → 20902 resource=recon_diff)
// → the W11 guard (20001 [recon_diff_id] with data.reason: not_payer_side_case, writeoff_disabled,
// withdrawal_not_returned, transfer_attempts_mismatch, amount_mismatch) → a withdrawal no longer
// APPROVED → 20902 resource=withdrawal. Every refusal changes nothing: difference, holds,
// withdrawal, attempts, vouchers, balances, events, jobs, audit; 2xxxx refusals are not stored
// as idempotent results (task §9.2). Requests go through the real admin entry (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  BODY,
  EXECUTE,
  SWITCH,
  answer,
  billLineJson,
  chars,
  denied,
  diffConflict,
  everything,
  expectWrittenOff,
  fixture,
  frozenMismatches,
  idempotencyRows,
  newKey,
  refused,
  returnedResolution,
  seedAttempt,
  seedCase,
  seedDiff,
  setSwitch,
  stepUpRequired,
  suite,
  withWriteOffAdmin,
  withdrawalConflict,
  writtenOff,
  BOOKED_AT_MS,
  type Case,
} from './kit.ts';

const s = suite();

it('[AC-B2-07e#22] 权限：只有 payout.execute（或超管）能核销；只有 fund.recon / fund.view、没有权限点、只有别的权限点 → 10403 data.reason=admin_permission_denied（note 全空白、不带二次验证也先判权限）；不带令牌 → 10001；被拒时什么都不变、不写审计', async () => {
  const f = fixture(s);
  const c = await seedCase(f);
  await withWriteOffAdmin(f, async (h) => {
    const before = await everything(f);
    const outsiders = [
      h.viewer,
      await h.caller([]),
      await h.caller(['pay.view', 'risk.freeze', 'fund.settle_adjust']),
    ];
    for (const caller of outsiders) {
      await denied(await h.writeOff(c.diff.id, BODY, { caller }));
      await denied(await h.writeOff(c.diff.id, { ...BODY, note: '   ' }, { caller, stepUp: null }));
    }
    await answer(await h.writeOff(c.diff.id, BODY, { caller: null }), 10001);
    expect(await everything(f)).toEqual(before);

    const root = await h.caller([], { superAdmin: true });
    await writtenOff(await h.writeOff(c.diff.id, BODY, { caller: root }));
  });
});

it('[AC-B2-07e#23] 二次验证（totp 档）：不带 X-Step-Up-Token、令牌是别的账号的 → 10003 data.tier=totp，先于请求体与差错单检查；什么都不变；拿到令牌后用同一 Idempotency-Key 重放即成功', async () => {
  const f = fixture(s);
  const c = await seedCase(f);
  await withWriteOffAdmin(f, async (h) => {
    const before = await everything(f);
    const key = newKey();
    const colleague = await h.caller([EXECUTE]);
    await stepUpRequired(await h.writeOff(c.diff.id, BODY, { key, stepUp: null }));
    await stepUpRequired(
      await h.writeOff(c.diff.id, BODY, { key, stepUp: await h.stepUp(colleague) }),
    );
    await stepUpRequired(await h.writeOff(c.diff.id, { ...BODY, note: '   ' }, { stepUp: null }));
    await stepUpRequired(await h.writeOff(randomUUID(), BODY, { stepUp: null }));
    expect(await everything(f)).toEqual(before);

    await writtenOff(await h.writeOff(c.diff.id, BODY, { key }));
  });
});

it('[AC-B2-07e#24] 请求体：note 去空白后为空、超过 200 字 → 20001 data.fields=[note]；缺 expected_withdrawal_status 或不是 APPROVED → 20001 data.fields=[expected_withdrawal_status]；请求体不合格时先于差错单 id 报；什么都不变；恰好 200 字的 note 可以核销并原样记入 resolution.note', async () => {
  const f = fixture(s);
  const c = await seedCase(f);
  await withWriteOffAdmin(f, async (h) => {
    const before = await everything(f);
    for (const note of ['   ', ' \t\n ', chars(201)]) {
      await answer(await h.writeOff(c.diff.id, { ...BODY, note }), 20001, { fields: ['note'] });
    }
    await answer(await h.writeOff(randomUUID(), { ...BODY, note: '   ' }), 20001, {
      fields: ['note'],
    });
    for (const body of [{}, { note: '核销' }, { expected_withdrawal_status: 'PAYING' }]) {
      await answer(await h.writeOff(c.diff.id, body), 20001, {
        fields: ['expected_withdrawal_status'],
      });
    }
    expect(await everything(f)).toEqual(before);

    await writtenOff(await h.writeOff(c.diff.id, { ...BODY, note: chars(200) }));
    await expectWrittenOff(f, c.diff, {
      adminId: h.executor.id,
      withdrawalId: c.w.id,
      paidAtMs: BOOKED_AT_MS,
      note: chars(200),
    });
  });
});

it('[AC-B2-07e#25] 差错单 id：不存在的 id、其他应用的差错单、source R4 的收款差错、不是 UUID 的 id → 20001 data.fields=[recon_diff_id]（不回 404，前三种应答一样，不带 reason）；什么都不变', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const foreign = await seedCase(other);
  const pay = await seedDiff(f, {
    source: 'R4',
    type: 'pay_mismatch',
    ref_type: 'pay_order',
    dedupe_key: `spec:${randomUUID()}`,
  });
  await withWriteOffAdmin(f, async (h) => {
    const before = await everything(f);
    const foreignBefore = await everything(other);
    const refusals: unknown[] = [];
    for (const id of [randomUUID(), foreign.diff.id, pay.id]) {
      const body = await answer(await h.writeOff(id, BODY), 20001, { fields: ['recon_diff_id'] });
      refusals.push({ code: body.code, msg: body.msg, data: body.data });
    }
    expect(new Set(refusals.map((refusal) => JSON.stringify(refusal))).size).toBe(1);
    await answer(await h.writeOff('not-a-uuid', BODY), 20001, { fields: ['recon_diff_id'] });
    expect(await everything(f)).toEqual(before);
    expect(await everything(other)).toEqual(foreignBefore);
  });
});

it('[AC-B2-07e#26] 已 closed / adjusted / written_off 的差错单 → 20902 data.resource=recon_diff（先于 W11 守卫）：差错单、提现单、冻结都不动；20902 不存为幂等结果（同一 key 再发仍是 20902）', async () => {
  const f = fixture(s);
  await withWriteOffAdmin(f, async (h) => {
    for (const status of ['closed', 'adjusted', 'written_off'] as const) {
      const c = await seedCase(f, {
        diff: () => ({
          status,
          handler_id: h.viewer.id,
          closed_at: new Date(f.clock.now().getTime() - 20 * 60_000),
        }),
      });
      const before = await everything(f);
      const key = newKey();
      await diffConflict(await h.writeOff(c.diff.id, BODY, { key }));
      await diffConflict(await h.writeOff(c.diff.id, BODY, { key }));
      expect(await everything(f)).toEqual(before);
      expect((await idempotencyRows(f)).filter((row) => row.key === key)).toEqual([]);
    }
  });
});

it('[AC-B2-07e#27] 不是 R2「支付宝成功、内部经 W9 退回」的差错单 → 20001 data.fields=[recon_diff_id] reason=not_payer_side_case：R1 / R3 差错单、R2 的别的情形（重复打款）、没有 withdrawal_id、账单行的 out_biz_no 是别的单；什么都不变', async () => {
  const f = fixture(s);
  const r1 = await seedCase(f, {
    diff: (w) => ({
      source: 'R1',
      type: 'union_mismatch',
      period: '2026-09',
      ref_type: 'order',
      ref_id: `taobao:${w.id}`,
    }),
  });
  const r3 = await seedCase(f, {
    diff: (w) => ({ source: 'R3', type: 'ledger_mismatch', ref_type: 'account', ref_id: w.userId }),
  });
  const duplicate = await seedCase(f, {
    diff: (w) => ({ resolution: { ...returnedResolution(w), case: 'duplicate_payout' } }),
  });
  const noWithdrawal = await seedCase(f, {
    diff: (w) => {
      const resolution = returnedResolution(w);
      delete resolution['withdrawal_id'];
      return { resolution };
    },
  });
  const elsewhere = await seedCase(f);
  const misnamed = await seedCase(f, {
    diff: (w) => ({
      resolution: returnedResolution(w, billLineJson({ ...w, outBizNo: elsewhere.w.outBizNo })),
    }),
  });
  await withWriteOffAdmin(f, async (h) => {
    const before = await everything(f);
    for (const c of [r1, r3, duplicate, noWithdrawal, misnamed]) {
      await refused(await h.writeOff(c.diff.id, BODY), 'not_payer_side_case');
    }
    expect(await everything(f)).toEqual(before);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-07e#28] 开关 payout.proven_success_writeoff.enabled=false → 20001 reason=writeoff_disabled（按差错单加调账处理）；什么都不变', async () => {
  const f = fixture(s);
  await setSwitch(f, SWITCH, false);
  const c = await seedCase(f);
  await withWriteOffAdmin(f, async (h) => {
    const before = await everything(f);
    await refused(await h.writeOff(c.diff.id, BODY), 'writeoff_disabled');
    await refused(await h.writeOff(c.diff.id, { ...BODY, note: '再试一次' }), 'writeoff_disabled');
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-07e#29] W11 守卫：单 APPROVED 但不是付款方侧退回 → withdrawal_not_returned；转账尝试没有、成功、两条失败 → transfer_attempts_mismatch；账单金额 ≠ net_fen → amount_mismatch；什么都不变、冻结不变量成立', async () => {
  const f = fixture(s);
  const notReturned = await seedCase(f, { withdrawal: { holdReason: null } });
  const cases = [
    await seedCase(f, { withdrawal: { attempts: [] } }),
    await seedCase(f, { withdrawal: { attempts: [['transfer', 'success']] } }),
    await seedCase(f, {
      withdrawal: {
        attempts: [
          ['transfer', 'fail'],
          ['transfer', 'fail'],
        ],
      },
    }),
  ];
  const amount = await seedCase(f, {
    withdrawal: { net: 1000n, fee: 30n, tax: 20n },
    diff: (w) => ({
      actual_fen: w.amount,
      diff_fen: -w.amount,
      resolution: returnedResolution(w, billLineJson(w, { amount_fen: w.amount.toString() })),
    }),
  });
  await withWriteOffAdmin(f, async (h) => {
    const before = await everything(f);
    await refused(await h.writeOff(notReturned.diff.id, BODY), 'withdrawal_not_returned');
    for (const c of cases) {
      await refused(await h.writeOff(c.diff.id, BODY), 'transfer_attempts_mismatch');
    }
    await refused(await h.writeOff(amount.diff.id, BODY), 'amount_mismatch');
    expect(await everything(f)).toEqual(before);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-07e#30] 守卫拒绝不存为幂等结果：没有转账尝试被拒后补上那条失败的转账尝试，同一 Idempotency-Key、同一请求体重发即核销成功', async () => {
  const f = fixture(s);
  const c = await seedCase(f, { withdrawal: { attempts: [] } });
  await withWriteOffAdmin(f, async (h) => {
    const key = newKey();
    await refused(await h.writeOff(c.diff.id, BODY, { key }), 'transfer_attempts_mismatch');
    expect((await idempotencyRows(f)).filter((row) => row.key === key)).toEqual([]);
    await seedAttempt(f.payout, f.appId, c.w.id, 'transfer', 'fail');

    const data = await writtenOff(await h.writeOff(c.diff.id, BODY, { key }));
    expect(data.released_hold_count).toBe(1);
    await expectWrittenOff(f, c.diff, {
      adminId: h.executor.id,
      withdrawalId: c.w.id,
      paidAtMs: BOOKED_AT_MS,
    });
  });
});

it('[AC-B2-07e#31] 提现单已不是 APPROVED（已到账 PAID_API、已驳回 REJECTED、又在打款 PAYING、FAILED）→ 20902 data.resource=withdrawal：终态单不改状态或金额，差错单、冻结都不动，不存为幂等结果', async () => {
  const f = fixture(s);
  const cases: Case[] = [];
  for (const status of ['PAID_API', 'REJECTED', 'PAYING', 'FAILED'] as const) {
    cases.push(await seedCase(f, { withdrawal: { status } }));
  }
  await withWriteOffAdmin(f, async (h) => {
    const before = await everything(f);
    for (const c of cases) {
      const key = newKey();
      await withdrawalConflict(await h.writeOff(c.diff.id, BODY, { key }));
      await withdrawalConflict(await h.writeOff(c.diff.id, BODY, { key }));
      expect((await idempotencyRows(f)).filter((row) => row.key === key)).toEqual([]);
    }
    expect(await everything(f)).toEqual(before);
  });
});
