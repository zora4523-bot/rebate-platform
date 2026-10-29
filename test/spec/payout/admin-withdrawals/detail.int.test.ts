// B2-09c detail rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// getAdminWithdrawal (GET /admin/v1/withdrawals/{withdrawal_id}: withdraw.review or fund.view, read
// only, no step-up; the fields of a list row plus the remaining columns; `payee` masked only —
// alipay 138****5678 or zh***@example.com, bank card 尾号 1234 with bank_name, the name with only the
// last character kept (BR-ID-33) — never the full account, name, openid or launch data; `batch` the
// payout_batches row of batch_id (null without one), `batch_items` every payout_batch_items row of
// this withdrawal oldest first; `payout_attempts` every attempt of this withdrawal oldest first as a
// summary, never the request or response body; `holds` the user's withdraw_holds in effect at
// response time (released_at null and hold_until null or later than the clock) oldest first; an
// unknown id or a withdrawal of another app → 20001 data.fields=[withdrawal_id], no 404; reading
// writes no audit record); 08 BR-WDR-10 细则 (详情展示 auto_decision 中未满足的条件作为转人工原因),
// BR-WDR-05 (会员有生效 withdraw_holds 时也可审核，审核人需看到), BR-ID-33. Requests go through the
// real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ACCOUNT,
  BANK_NAME,
  DETAIL_KEYS,
  MASKED_NAME,
  REVIEW,
  VIEW,
  ago,
  allAudits,
  answer,
  attemptView,
  detailOf,
  detailView,
  expectNoSecrets,
  fixture,
  footprint,
  holdView,
  itemView,
  later,
  listPart,
  normalize,
  page,
  secretsOf,
  seedAttempt,
  seedBatch,
  seedHold,
  seedItem,
  seedMember,
  seedWithdrawal,
  suite,
  withAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09c#9] 提现单详情（withdraw.review 或 fund.view 任一即可，超管也能读）：恰好是契约的 AdminWithdrawalDetail——列表行的全部字段（与列表里同一单的值一致）加其余各列（打款方式、审核时限、失败码、执行人与时刻、执行序号、人工处置与处置人、手动打款录入与确认人、受阻时刻、通道状态、确认时限、通道流水号、updated_at、row_version）、脱敏收款人、当前批次及其明细、转账尝试摘要、该用户生效的冻结；自动判定存储里缺的键读作 null，没有判定为 null，风险标签快照原样（没有为 []），resolver_ids 没有为 []', async () => {
  const f = fixture(s);
  await withAdmin(f, async (h) => {
    const a = await seedMember(f, h);
    const b = await seedMember(f, h, null);
    const hold = await seedHold(f, a, { reason: 'manual', created_at: ago(f, 300) });
    const batch = await seedBatch(f, {
      kind: 'manual',
      by: h.reviewer.id,
      created_at: ago(f, 201),
    });
    const settled = await seedWithdrawal(f, h, a, {
      method: 'bank_card',
      status: 'PAID_MANUAL',
      review_mode: 'manual',
      amount_fen: 30_000n,
      fee_fen: 100n,
      auto_decision: {
        result: 'manual',
        failed_conditions: ['max_amount'],
        warn_values: {
          high_commission_order_ratio_bp: 0,
          invalid_ratio_bp: 0,
          withdraw_received_ratio_bp: 900,
        },
        rule_version: 2,
        decided_at: ago(f, 239).toISOString(),
      },
      risk_flags: [{ code: 'credited_today', value: true, threshold: null }],
      risk_flags_at: ago(f, 240),
      review_deadline: later(f, 1_200),
      reviewer_id: h.reviewer.id,
      reviewed_at: ago(f, 230),
      executor_id: h.reviewer.id,
      executed_at: ago(f, 200),
      execute_seq: 1,
      batch_id: batch.id,
      needs_manual: true,
      manual_resolution: 'paid',
      resolver_ids: [h.viewer.id],
      manual_entry_by: h.viewer.id,
      manual_confirm_by: h.reviewer.id,
      channel_order_id: 'SYN2026103000000001',
      paid_at: ago(f, 20),
      created_at: ago(f, 240),
      updated_at: ago(f, 20),
      row_version: 6,
    });
    const settledItem = await seedItem(f, settled, batch, { result: 'paying', at: ago(f, 200) });
    const settledQuery = await seedAttempt(f, settled, {
      kind: 'query',
      result: 'unknown',
      respCode: 'SYSTEM_ERROR',
      at: ago(f, 100),
    });
    const settledTransfer = await seedAttempt(f, settled, {
      kind: 'transfer',
      result: 'unknown',
      respCode: 'SYSTEM_ERROR',
      respSubCode: 'SYN_TIMEOUT',
      at: ago(f, 199),
    });
    const handle = await seedWithdrawal(f, h, a, {
      method: 'alipay',
      account: '13800005678',
      status: 'APPROVED',
      review_mode: 'auto',
      amount_fen: 2_000n,
      auto_decision: {
        result: 'auto',
        failed_conditions: [],
        warn_values: {
          high_commission_order_ratio_bp: null,
          invalid_ratio_bp: null,
          withdraw_received_ratio_bp: 1500,
        },
        rule_version: 3,
        decided_at: ago(f, 59).toISOString(),
        execute_blocked: 'payout_disabled',
      },
      risk_flags: [
        { code: 'withdraw_vs_received', value: null, threshold: 3000 },
        {
          code: 'risk_calc_failed',
          value: ['invalid_ratio_60d', 'high_commission_ratio_60d'],
          threshold: null,
        },
      ],
      risk_flags_at: ago(f, 60),
      reviewed_at: ago(f, 59),
      execute_seq: 1,
      hold_reason: 'payer_side_after_transfer',
      hold_at: ago(f, 30),
      created_at: ago(f, 60),
      updated_at: ago(f, 30),
      row_version: 4,
    });
    const handleTransfer = await seedAttempt(f, handle, {
      kind: 'transfer',
      result: 'fail',
      respCode: 'PAYER_BALANCE_NOT_ENOUGH',
      respSubCode: 'SYN_SUB',
      at: ago(f, 40),
    });
    const fresh = await seedWithdrawal(f, h, b, {
      method: 'alipay',
      account: ACCOUNT.alipay,
      created_at: ago(f, 5),
    });
    const cases = [
      {
        row: settled,
        view: detailView(settled, a, {
          payee: { masked_account: '尾号 3445', masked_name: MASKED_NAME, bank_name: BANK_NAME },
          batch,
          items: [settledItem],
          attempts: [settledTransfer, settledQuery],
          holds: [hold],
        }),
      },
      {
        row: handle,
        view: detailView(handle, a, {
          payee: { masked_account: '138****5678', masked_name: MASKED_NAME, bank_name: null },
          batch: null,
          items: [],
          attempts: [handleTransfer],
          holds: [hold],
        }),
      },
      {
        row: fresh,
        view: detailView(fresh, b, {
          payee: {
            masked_account: 'sy***@example.test',
            masked_name: MASKED_NAME,
            bank_name: null,
          },
          batch: null,
          items: [],
          attempts: [],
          holds: [],
        }),
      },
    ];
    const before = await footprint(f);
    const root = await h.caller([], { superAdmin: true });
    const listed = (await page(await h.list())).items.map(normalize);
    for (const { row, view } of cases) {
      for (const who of [h.reviewer, h.viewer, await h.caller([REVIEW, VIEW]), root]) {
        const sent = await h.detail(row.id, who);
        const data = await detailOf(sent);
        expect(Object.keys(data).sort(), sent.body).toEqual(DETAIL_KEYS);
        expect(data, sent.body).toEqual(view);
      }
      const shown = await detailOf(await h.detail(row.id));
      const item = listed.find(
        (entry) => (entry as { withdrawal_id: string }).withdrawal_id === row.id,
      );
      expect(item, row.id).toEqual(listPart(shown));
    }
    const blockedBy: unknown[] = [];
    for (const row of [settled, handle]) {
      const decision = (await detailOf(await h.detail(row.id)))['auto_decision'];
      blockedBy.push((decision as { execute_blocked: unknown }).execute_blocked);
    }
    expect(blockedBy).toEqual([null, 'payout_disabled']);
    const handled = await detailOf(await h.detail(handle.id));
    expect([handled['display_status'], handled['hold_reason']]).toEqual([
      'pending_handle',
      'payer_side_after_transfer',
    ]);
    const empty = await detailOf(await h.detail(fresh.id));
    expect({
      auto_decision: empty['auto_decision'],
      risk_flags: empty['risk_flags'],
      risk_flags_at: empty['risk_flags_at'],
      resolver_ids: empty['resolver_ids'],
      user: empty['user'],
    }).toEqual({
      auto_decision: null,
      risk_flags: [],
      risk_flags_at: null,
      resolver_ids: [],
      user: { user_id: b.userId, phone_masked: null },
    });
    expect(await footprint(f)).toEqual(before);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09c#10] 提现单详情的收款人只出脱敏值（BR-ID-33）：支付宝手机号 138****5678、支付宝邮箱 sy***@example.test、银行卡「尾号 1234」并带开户行（其他方式 bank_name 为 null），姓名只留末字（**甲）；应答正文任何位置都不含收款人姓名、收款账号明文、账号密文与盲索引、用户完整手机号', async () => {
  const f = fixture(s);
  await withAdmin(f, async (h) => {
    const m = await seedMember(f, h, '13912340002');
    // [method, account in clear, payee name, masked account, masked name]
    const cases = [
      ['alipay', '13800005678', '合成甲', '138****5678', '**甲'],
      ['alipay', 'zh.payee@example.test', '测试乙', 'zh***@example.test', '**乙'],
      ['alipay', ACCOUNT.alipay, '合成丙', 'sy***@example.test', '**丙'],
      ['bank_card', '6222020200001234', '测试丁', '尾号 1234', '**丁'],
      ['bank_card', ACCOUNT.bank_card, '合成戊', '尾号 3445', '**戊'],
    ] as const;
    for (const [index, [method, account, name, masked, mark]] of cases.entries()) {
      const row = await seedWithdrawal(f, h, m, {
        method,
        account,
        payee_name: name,
        created_at: ago(f, 10 - index),
      });
      const sent = await h.detail(row.id);
      const data = await detailOf(sent);
      expect(data['payee'], masked).toEqual({
        masked_account: masked,
        masked_name: mark,
        bank_name: method === 'bank_card' ? BANK_NAME : null,
      });
      expect(data['user']).toEqual({ user_id: m.userId, phone_masked: '139****0002' });
      expectNoSecrets(sent.body, secretsOf(row, account, m));
    }
  });
});

it('[AC-B2-09c#11] 提现单详情的批次：batch 是 batch_id 指向的 payout_batches 行（批次号、类型、创建时刻；没有 batch_id 为 null），batch_items 是本单全部 payout_batch_items 行按 at 正序（含被拦下、移出到新批次与进入打款），别的单的明细不出现', async () => {
  const f = fixture(s);
  await withAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const first = await seedBatch(f, { kind: 'auto', created_at: ago(f, 60) });
    const second = await seedBatch(f, {
      kind: 'manual',
      by: h.reviewer.id,
      created_at: ago(f, 32),
    });
    const moved = await seedWithdrawal(f, h, m, {
      status: 'PAYING',
      review_mode: 'manual',
      reviewer_id: h.reviewer.id,
      reviewed_at: ago(f, 70),
      executor_id: h.reviewer.id,
      executed_at: ago(f, 29),
      execute_seq: 2,
      batch_id: second.id,
      created_at: ago(f, 80),
      updated_at: ago(f, 29),
    });
    const neighbour = await seedWithdrawal(f, h, m, {
      status: 'PAYING',
      review_mode: 'auto',
      executed_at: ago(f, 59),
      execute_seq: 1,
      batch_id: first.id,
      created_at: ago(f, 75),
    });
    const unbatched = await seedWithdrawal(f, h, m, { created_at: ago(f, 10) });
    // Inserted out of order: the response orders by `at`.
    const paying = await seedItem(f, moved, second, { result: 'paying', at: ago(f, 29) });
    const blocked = await seedItem(f, moved, first, {
      result: 'blocked',
      reason: 'watermark_below_forecast',
      at: ago(f, 59),
    });
    const out = await seedItem(f, moved, first, {
      result: 'moved_out',
      movedTo: second,
      at: ago(f, 31),
    });
    await seedItem(f, neighbour, first, { result: 'paying', at: ago(f, 58) });
    await seedItem(f, neighbour, second, { result: 'skipped', reason: 'paying', at: ago(f, 28) });

    const data = await detailOf(await h.detail(moved.id));
    expect(data['batch']).toEqual({
      batch_id: second.id,
      kind: 'manual',
      created_at: second.created_at.getTime(),
    });
    expect(data['batch_items']).toEqual([blocked, out, paying].map(itemView));
    const other = await detailOf(await h.detail(neighbour.id));
    expect(other['batch']).toEqual({
      batch_id: first.id,
      kind: 'auto',
      created_at: first.created_at.getTime(),
    });
    expect((other['batch_items'] as unknown[]).length).toBe(2);
    const none = await detailOf(await h.detail(unbatched.id));
    expect([none['batch_id'], none['batch'], none['batch_items']]).toEqual([null, null, []]);
  });
});

it('[AC-B2-09c#12] 提现单详情的转账尝试只给摘要：本单全部 payout_attempts 按 at 正序，每条恰好是 attempt_id、kind、result、resp_code、resp_sub_code、at；通道请求与应答正文（含其中的收款信息）不出现；别的单的尝试不出现', async () => {
  const f = fixture(s);
  await withAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const w = await seedWithdrawal(f, h, m, {
      status: 'PAYING',
      review_mode: 'auto',
      executed_at: ago(f, 50),
      execute_seq: 1,
      created_at: ago(f, 60),
    });
    const neighbour = await seedWithdrawal(f, h, m, {
      status: 'PAYING',
      review_mode: 'auto',
      executed_at: ago(f, 40),
      execute_seq: 1,
      created_at: ago(f, 45),
    });
    const marker = `synthetic-channel-body-${randomUUID()}`;
    const body = (step: string) => ({
      marker: `${marker}-${step}`,
      payee: { identity: ACCOUNT.alipay, name: '合成甲' },
      sign: `${marker}-sign-${step}`,
    });
    // Inserted out of order: the response orders by `at`.
    const last = await seedAttempt(f, w, {
      kind: 'query',
      result: 'success',
      respCode: '10000',
      at: ago(f, 10),
      request: body('q2-request'),
      response: body('q2-response'),
    });
    const transfer = await seedAttempt(f, w, {
      kind: 'transfer',
      result: 'unknown',
      respCode: 'SYSTEM_ERROR',
      respSubCode: 'SYN_TIMEOUT',
      at: ago(f, 49),
      request: body('t-request'),
      response: body('t-response'),
    });
    const middle = await seedAttempt(f, w, {
      kind: 'query',
      result: 'pending',
      at: ago(f, 30),
      request: body('q1-request'),
    });
    await seedAttempt(f, neighbour, {
      kind: 'transfer',
      result: 'pending',
      at: ago(f, 39),
      request: body('n-request'),
    });

    const sent = await h.detail(w.id);
    const data = await detailOf(sent);
    expect(data['payout_attempts']).toEqual([transfer, middle, last].map(attemptView));
    for (const attempt of data['payout_attempts'] as Record<string, unknown>[]) {
      expect(Object.keys(attempt).sort()).toEqual([
        'at',
        'attempt_id',
        'kind',
        'resp_code',
        'resp_sub_code',
        'result',
      ]);
    }
    expectNoSecrets(sent.body, [marker, ACCOUNT.alipay, '合成甲']);
    const other = await detailOf(await h.detail(neighbour.id));
    expect((other['payout_attempts'] as Record<string, unknown>[]).map((a) => a['kind'])).toEqual([
      'transfer',
    ]);
  });
});

it('[AC-B2-09c#13] 提现单详情的冻结：只列该用户在应答时刻生效的 withdraw_holds（released_at 为空，且 hold_until 为空或晚于时钟），按创建时刻正序；已解除、已到期（含恰好等于时钟）的不列，别的用户与别的应用的冻结不列；同一用户的每张单看到同样的冻结', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await withAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const neighbour = await seedMember(f, h);
    const stranger = await seedMember(other, h);
    const forever = await seedHold(f, m, { reason: 'manual', created_at: ago(f, 300) });
    const diff = await seedHold(f, m, {
      reason: 'recon_diff',
      sourceRef: randomUUID(),
      created_at: ago(f, 200),
    });
    const watch = await seedHold(f, m, {
      reason: 'manual_failed_watch',
      created_at: ago(f, 100),
      hold_until: later(f, 60),
    });
    const ledger = await seedHold(f, m, { reason: 'ledger_mismatch', created_at: ago(f, 50) });
    // Not in effect: expired, expiring exactly now, released.
    await seedHold(f, m, {
      reason: 'manual_failed_watch',
      created_at: ago(f, 400),
      hold_until: ago(f, 1),
    });
    await seedHold(f, m, {
      reason: 'manual_failed_watch',
      created_at: ago(f, 250),
      hold_until: f.clock.now(),
    });
    await seedHold(f, m, { reason: 'manual', created_at: ago(f, 150), released_at: ago(f, 10) });
    // Someone else's.
    await seedHold(f, neighbour, { reason: 'manual', created_at: ago(f, 120) });
    await seedHold(other, stranger, { reason: 'manual', created_at: ago(f, 110) });

    const first = await seedWithdrawal(f, h, m, { created_at: ago(f, 20) });
    const second = await seedWithdrawal(f, h, m, {
      status: 'REJECTED',
      review_mode: 'manual',
      reviewer_id: h.reviewer.id,
      reviewed_at: ago(f, 15),
      reject_reason_code: 'RISK_SUSPECT',
      created_at: ago(f, 18),
    });
    const theirs = await seedWithdrawal(f, h, neighbour, { created_at: ago(f, 16) });
    const free = await seedMember(f, h);
    const clean = await seedWithdrawal(f, h, free, { created_at: ago(f, 12) });
    const want = [forever, diff, watch, ledger].map(holdView);
    expect((await detailOf(await h.detail(first.id)))['holds']).toEqual(want);
    expect((await detailOf(await h.detail(second.id, h.viewer)))['holds']).toEqual(want);
    expect((await detailOf(await h.detail(theirs.id)))['holds']).toHaveLength(1);
    expect((await detailOf(await h.detail(clean.id)))['holds']).toEqual([]);
  });
});

it('[AC-B2-09c#14] 提现单详情的拒绝：不存在的 id、其他应用的提现单 → 20001 data.fields=[withdrawal_id]（不回 404，两种情形应答一样）；id 不是 UUID 或超过 64 字符 → 20001 [withdrawal_id]；没有 withdraw.review / fund.view → 10403；不带令牌 → 10001；读取不写审计、不改任何行', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await withAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const own = await seedWithdrawal(f, h, m, { created_at: ago(f, 5) });
    const stranger = await seedMember(other, h);
    const foreign = await seedWithdrawal(other, h, stranger, { created_at: ago(f, 4) });
    const before = await footprint(f);
    const refusals: unknown[] = [];
    for (const id of [randomUUID(), foreign.id]) {
      const body = await answer(await h.detail(id), 20001, { fields: ['withdrawal_id'] });
      refusals.push({ code: body.code, msg: body.msg, data: body.data });
      await answer(await h.detail(id, h.viewer), 20001, { fields: ['withdrawal_id'] });
    }
    expect(new Set(refusals.map((refusal) => JSON.stringify(refusal))).size).toBe(1);
    await answer(await h.detail('not-a-uuid'), 20001, { fields: ['withdrawal_id'] });
    await answer(await h.detail('x'.repeat(65)), 20001, { fields: ['withdrawal_id'] });
    await answer(await h.detail(own.id, await h.caller([])), 10403);
    await answer(await h.detail(own.id, await h.caller(['fund.recon', 'pay.view'])), 10403);
    await answer(await h.detail(own.id, await h.caller(['pii.reveal_identity'])), 10403);
    await answer(await h.detail(own.id, null), 10001);
    expect((await detailOf(await h.detail(own.id)))['withdrawal_id']).toBe(own.id);
    expect((await detailOf(await h.detail(own.id, h.viewer)))['withdrawal_id']).toBe(own.id);
    expect(await footprint(f)).toEqual(before);
  });
  expect(await allAudits(f)).toEqual([]);
});
