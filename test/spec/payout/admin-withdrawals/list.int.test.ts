// B2-09c list rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// listAdminWithdrawals (GET /admin/v1/withdrawals: withdraw.review or fund.view, read only, no
// step-up; only the app's withdrawals; each row the contract's AdminWithdrawalListItem — the user
// with the phone masked 3 + 4, display_status derived as BR-WDR-08 细则, the four amounts in fen as
// stored, auto_decision with a missing key read as null, the risk_flags snapshot as stored ([] when
// none), no payee account or name; filters combine with AND; a value outside an enum or a pattern
// → 20001 data.fields naming it; amount_min_fen > amount_max_fen and created_from > created_to →
// 20001 with both fields; created_at then withdrawal_id descending; page_size ≤ 200; a page past the
// last → items=[]; total = count of the filter set; reading writes no audit record); 08 BR-WDR-10
// 细则 (审核列表展示 risk_flags、blocked_reason 的「暂停」、auto_decision 的转人工原因; 判为 auto 的单
// 也保留在列表中可查), BR-ID-33 (手机号 3+4，接口不出现明文). Requests go through the real admin
// entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ACCOUNT,
  LIST_KEYS,
  REVIEW,
  VIEW,
  ago,
  allAudits,
  answer,
  expectNoSecrets,
  fixture,
  footprint,
  ids,
  later,
  listView,
  newestFirst,
  normalize,
  page,
  secretsOf,
  seedBatch,
  seedMember,
  seedWithdrawal,
  suite,
  withAdmin,
  withOffset,
  type WithdrawalRow,
  type WithdrawalSeed,
} from './kit.ts';

const s = suite();
/** 2^53 − 1: the largest fen amount a JSON number carries exactly. */
const BIG = 9_007_199_254_740_991n;

it('[AC-B2-09c#1] 提现单列表（withdraw.review 或 fund.view 任一即可，两点都有、超管也能读，不要 step-up）：只列本应用的提现单，按申请时间倒序，每行恰好是契约的 AdminWithdrawalListItem——用户（手机号 3+4，没绑手机为 null）、状态与推导的 display_status、审核方式、通道、四个金额、自动判定（存储里缺的键读作 null）、受阻原因、「暂停」、needs_manual、驳回原因与内部备注、审核人与时刻、批次、风险标签快照（没有为 []）、申请与到账时刻；其他应用的单不出现；默认 page 1 / page_size 20；读取不写审计、不改任何行', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await withAdmin(f, async (h) => {
    const a = await seedMember(f, h);
    const b = await seedMember(f, h, null);
    const batch = await seedBatch(f, { kind: 'auto', created_at: ago(f, 49) });
    const pending = await seedWithdrawal(f, h, a, {
      status: 'PENDING_REVIEW',
      review_mode: 'manual',
      amount_fen: 50_000n,
      auto_decision: {
        result: 'manual',
        failed_conditions: ['max_amount', 'risk_flag:first_withdrawal'],
        warn_values: {
          high_commission_order_ratio_bp: 1200,
          invalid_ratio_bp: 300,
          withdraw_received_ratio_bp: 4500,
        },
        rule_version: 3,
        decided_at: ago(f, 59).toISOString(),
      },
      risk_flags: [
        { code: 'first_withdrawal', value: true, threshold: null },
        { code: 'withdraw_vs_received', value: 4500, threshold: 3000 },
      ],
      risk_flags_at: ago(f, 60),
      review_deadline: later(f, 1_380),
      created_at: ago(f, 60),
      updated_at: ago(f, 59),
    });
    const paidAuto = await seedWithdrawal(f, h, a, {
      status: 'PAID_API',
      review_mode: 'auto',
      amount_fen: 2_000n,
      fee_fen: 100n,
      tax_fen: 50n,
      auto_decision: {
        result: 'auto',
        failed_conditions: [],
        warn_values: {
          high_commission_order_ratio_bp: null,
          invalid_ratio_bp: null,
          withdraw_received_ratio_bp: 2000,
        },
        rule_version: 4,
        decided_at: ago(f, 50).toISOString(),
        execute_blocked: null,
      },
      reviewed_at: ago(f, 50),
      executed_at: ago(f, 49),
      execute_seq: 1,
      batch_id: batch.id,
      risk_flags: [],
      risk_flags_at: ago(f, 50),
      paid_at: ago(f, 48),
      channel_order_id: 'SYN20261030000001',
      created_at: ago(f, 50),
      updated_at: ago(f, 48),
    });
    const rejected = await seedWithdrawal(f, h, b, {
      method: 'bank_card',
      status: 'REJECTED',
      review_mode: 'manual',
      reviewer_id: h.reviewer.id,
      reviewed_at: ago(f, 35),
      reject_reason_code: 'PAYEE_INFO_INVALID',
      reject_note: '收款户名与实名不符（合成）',
      created_at: ago(f, 40),
      updated_at: ago(f, 35),
    });
    const paused = await seedWithdrawal(f, h, b, {
      method: 'bank_card',
      status: 'APPROVED',
      review_mode: 'manual',
      reviewer_id: h.reviewer.id,
      reviewed_at: ago(f, 25),
      hold_reason: 'member_blocked',
      hold_at: ago(f, 5),
      blocked_reason: 'NEGATIVE_BALANCE',
      risk_flags: [{ code: 'had_negative', value: true, threshold: null }],
      risk_flags_at: ago(f, 30),
      created_at: ago(f, 30),
      updated_at: ago(f, 5),
    });
    const paying = await seedWithdrawal(f, h, a, {
      method: 'wechat',
      status: 'PAYING',
      review_mode: 'auto',
      needs_manual: true,
      executed_at: ago(f, 15),
      execute_seq: 1,
      batch_id: batch.id,
      channel_state: 'wait_user_confirm',
      confirm_deadline: later(f, 1_440),
      created_at: ago(f, 20),
      updated_at: ago(f, 15),
    });
    const paidManual = await seedWithdrawal(f, h, b, {
      status: 'PAID_MANUAL',
      review_mode: 'manual',
      reviewer_id: h.reviewer.id,
      reviewed_at: ago(f, 9),
      manual_entry_by: h.reviewer.id,
      manual_confirm_by: h.viewer.id,
      paid_at: ago(f, 8),
      created_at: ago(f, 10),
      updated_at: ago(f, 8),
    });
    // Another app's withdrawals, all newer.
    const stranger = await seedMember(other, h);
    await seedWithdrawal(other, h, stranger, { created_at: ago(f, 2) });
    await seedWithdrawal(other, h, stranger, { status: 'APPROVED', created_at: ago(f, 1) });
    const member = (row: WithdrawalRow) => (row.user_id === a.userId ? a : b);
    const rows = [paidManual, paying, paused, rejected, paidAuto, pending];
    const expected = rows.map((row) => listView(row, member(row)));
    const before = await footprint(f);

    for (const who of [h.reviewer, h.viewer, await h.caller([REVIEW, VIEW])]) {
      const data = await page(await h.list({}, who));
      expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
        page: 1,
        page_size: 20,
        total: 6,
      });
      for (const item of data.items) expect(Object.keys(item).sort()).toEqual([...LIST_KEYS]);
      expect(data.items.map(normalize)).toEqual(expected);
    }
    const root = await h.caller([], { superAdmin: true });
    expect((await page(await h.list({}, root))).items.map(normalize)).toEqual(expected);
    const shown = (await page(await h.list())).items;
    expect(shown.map((item) => item['display_status'])).toEqual([
      'paid_manual',
      'paying',
      'pending_review',
      'rejected',
      'paid_auto_system',
      'pending_review',
    ]);
    expect(shown.map((item) => item['user'])).toEqual(
      rows.map((row) => ({ user_id: row.user_id, phone_masked: member(row).phoneMasked })),
    );
    expect(await footprint(f)).toEqual(before);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09c#2] 提现单列表的排序与分页：created_at 倒序，同一时刻按 withdrawal_id 倒序；page / page_size 翻页，total 为全部条数；超过最后一页是空 items（不报错）；page_size 200 可用', async () => {
  const f = fixture(s);
  await withAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const rows: WithdrawalRow[] = [];
    for (const minutes of [70, 10, 50, 30, 30, 30, 90]) {
      rows.push(
        await seedWithdrawal(f, h, m, { created_at: ago(f, minutes), updated_at: ago(f, minutes) }),
      );
    }
    const order = newestFirst(rows).map((row) => row.id);
    expect(await ids(await h.list())).toEqual(order);
    const walked: unknown[] = [];
    for (const n of [1, 2, 3]) {
      const data = await page(await h.list({ page: String(n), page_size: '3' }));
      expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
        page: n,
        page_size: 3,
        total: 7,
      });
      walked.push(...data.items.map((item) => item['withdrawal_id']));
    }
    expect(walked).toEqual(order);
    expect(await page(await h.list({ page: '4', page_size: '3' }))).toEqual({
      items: [],
      page: 4,
      page_size: 3,
      total: 7,
    });
    const all = await page(await h.list({ page: '1', page_size: '200' }));
    expect({ page_size: all.page_size, total: all.total }).toEqual({ page_size: 200, total: 7 });
    expect(all.items.map((item) => item['withdrawal_id'])).toEqual(order);
  });
});

it('[AC-B2-09c#3] 提现单列表的筛选：status、review_mode（未判定的 null 永不命中）、payout_channel、user_id（他应用的用户、不存在或不是 UUID 的值是空页）、out_biz_no（完整单号精确匹配，不是前缀、区分大小写）、amount_min_fen / amount_max_fen（两端都含）、created_from（含）/ created_to（不含，ISO 8601 带时区）、hold_reason、blocked（true 只要有 blocked_reason 的，false 只要没有的）、risk_flag（快照里有该 code 的；risk_calc_failed 值里列出的 code 不算命中）按 AND 组合，total 为过滤后的总数', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await withAdmin(f, async (h) => {
    const m1 = await seedMember(f, h);
    const m2 = await seedMember(f, h);
    const at = (minutes: number) => ({ created_at: ago(f, minutes), updated_at: ago(f, minutes) });
    const w1 = await seedWithdrawal(f, h, m1, { amount_fen: 1_000n, ...at(100) });
    const w2 = await seedWithdrawal(f, h, m1, {
      method: 'bank_card',
      status: 'APPROVED',
      review_mode: 'manual',
      amount_fen: 5_000n,
      hold_reason: 'daily_cap',
      risk_flags: [{ code: 'first_withdrawal', value: true, threshold: null }],
      risk_flags_at: ago(f, 90),
      ...at(90),
    });
    const w3 = await seedWithdrawal(f, h, m2, {
      status: 'APPROVED',
      review_mode: 'auto',
      amount_fen: 10_000n,
      hold_reason: 'payer_side_after_transfer',
      blocked_reason: 'NEGATIVE_BALANCE',
      risk_flags: [
        { code: 'had_negative', value: true, threshold: null },
        { code: 'recon_diff', value: true, threshold: null },
      ],
      risk_flags_at: ago(f, 80),
      ...at(80),
    });
    const w4 = await seedWithdrawal(f, h, m2, {
      method: 'wechat',
      status: 'PAID_API',
      review_mode: 'auto',
      amount_fen: 20_000n,
      risk_flags: [],
      risk_flags_at: ago(f, 70),
      ...at(70),
    });
    const w5 = await seedWithdrawal(f, h, m1, {
      status: 'REJECTED',
      review_mode: 'manual',
      amount_fen: 5_000n,
      reject_reason_code: 'NEGATIVE_BALANCE',
      blocked_reason: 'NEGATIVE_BALANCE',
      risk_flags: [{ code: 'risk_calc_failed', value: ['invalid_ratio_60d'], threshold: null }],
      risk_flags_at: ago(f, 60),
      ...at(60),
    });
    const w6 = await seedWithdrawal(f, h, m2, {
      method: 'bank_card',
      status: 'FAILED',
      review_mode: 'manual',
      amount_fen: 99_999n,
      fail_code: 'PAYEE_ACCOUNT_INVALID',
      risk_flags: [
        { code: 'first_withdrawal', value: true, threshold: null },
        { code: 'credited_today', value: true, threshold: null },
      ],
      risk_flags_at: ago(f, 50),
      ...at(50),
    });
    // Another app's withdrawals that every filter below would match.
    const stranger = await seedMember(other, h);
    const foreign = await seedWithdrawal(other, h, stranger, {
      method: 'bank_card',
      status: 'APPROVED',
      review_mode: 'auto',
      amount_fen: 10_000n,
      hold_reason: 'payer_side_after_transfer',
      blocked_reason: 'NEGATIVE_BALANCE',
      risk_flags: [{ code: 'recon_diff', value: true, threshold: null }],
      risk_flags_at: ago(f, 75),
      ...at(75),
    });

    const listed = async (query: Record<string, string>, want: WithdrawalRow[]) => {
      const data = await page(await h.list(query));
      expect(data.total, JSON.stringify(query)).toBe(want.length);
      const got = data.items.map((item) => item['withdrawal_id']);
      expect(got, JSON.stringify(query)).toEqual(want.map((row) => row.id));
    };
    await listed({}, [w6, w5, w4, w3, w2, w1]);
    await listed({ status: 'APPROVED' }, [w3, w2]);
    await listed({ status: 'PENDING_REVIEW' }, [w1]);
    await listed({ status: 'PAYING' }, []);
    await listed({ review_mode: 'auto' }, [w4, w3]);
    await listed({ review_mode: 'manual' }, [w6, w5, w2]);
    await listed({ payout_channel: 'bank_card' }, [w6, w2]);
    await listed({ payout_channel: 'wechat' }, [w4]);
    await listed({ payout_channel: 'alipay' }, [w5, w3, w1]);
    await listed({ user_id: m1.userId }, [w5, w2, w1]);
    await listed({ user_id: stranger.userId }, []);
    await listed({ user_id: randomUUID() }, []);
    await listed({ user_id: 'not-a-uuid' }, []);
    await listed({ out_biz_no: w3.out_biz_no }, [w3]);
    await listed({ out_biz_no: w3.out_biz_no.toLowerCase() }, []);
    await listed({ out_biz_no: w3.out_biz_no.slice(0, -1) }, []);
    await listed({ out_biz_no: foreign.out_biz_no }, []);
    await listed({ amount_min_fen: '5000' }, [w6, w5, w4, w3, w2]);
    await listed({ amount_max_fen: '5000' }, [w5, w2, w1]);
    await listed({ amount_min_fen: '5000', amount_max_fen: '5000' }, [w5, w2]);
    await listed({ amount_min_fen: '5001', amount_max_fen: '19999' }, [w3]);
    await listed({ amount_min_fen: '100000' }, []);
    await listed({ created_from: withOffset(ago(f, 80)) }, [w6, w5, w4, w3]);
    await listed({ created_to: withOffset(ago(f, 80)) }, [w2, w1]);
    const span = { created_from: ago(f, 90).toISOString(), created_to: ago(f, 60).toISOString() };
    await listed(span, [w4, w3, w2]);
    await listed({ hold_reason: 'payer_side_after_transfer' }, [w3]);
    await listed({ hold_reason: 'daily_cap' }, [w2]);
    await listed({ hold_reason: 'queue_paused' }, []);
    await listed({ blocked: 'true' }, [w5, w3]);
    await listed({ blocked: 'false' }, [w6, w4, w2, w1]);
    await listed({ risk_flag: 'first_withdrawal' }, [w6, w2]);
    await listed({ risk_flag: 'recon_diff' }, [w3]);
    await listed({ risk_flag: 'risk_calc_failed' }, [w5]);
    await listed({ risk_flag: 'invalid_ratio_60d' }, []);
    await listed({ risk_flag: 'blacklist_hit' }, []);
    await listed({ status: 'APPROVED', blocked: 'true' }, [w3]);
    await listed({ user_id: m2.userId, review_mode: 'auto' }, [w4, w3]);
    await listed({ payout_channel: 'alipay', amount_min_fen: '5000' }, [w5, w3]);
    await listed({ risk_flag: 'first_withdrawal', status: 'FAILED', blocked: 'false' }, [w6]);
    const second = await page(await h.list({ user_id: m1.userId, page: '2', page_size: '2' }));
    expect(second.total).toBe(3);
    expect(second.items.map((item) => item['withdrawal_id'])).toEqual([w1.id]);
  });
});

it('[AC-B2-09c#4] display_status 按 BR-WDR-08 细则由 status + review_mode + hold_reason 推导：PENDING_REVIEW 与 APPROVED（hold_reason 不是 payer_side_after_transfer）为 pending_review，APPROVED + payer_side_after_transfer 为 pending_handle，REJECTED 为 rejected，PAID_MANUAL 为 paid_manual，PAID_API 判 auto 为 paid_auto_system、其余为 paid_auto_review，PAYING（含 needs_manual）为 paying，FAILED 为 failed；display_status 筛选恰好返回推导为该值的单，可与 status 组合', async () => {
  const f = fixture(s);
  const HOLDS = [
    'payout_disabled',
    'queue_paused',
    'channel_disabled',
    'member_blocked',
    'single_cap',
    'daily_cap',
  ] as const;
  const cases: [WithdrawalSeed, string][] = [
    [{ status: 'PENDING_REVIEW' }, 'pending_review'],
    [{ status: 'PENDING_REVIEW', review_mode: 'manual' }, 'pending_review'],
    [{ status: 'APPROVED', review_mode: 'auto' }, 'pending_review'],
    [{ status: 'APPROVED', review_mode: 'manual' }, 'pending_review'],
    ...HOLDS.map((hold): [WithdrawalSeed, string] => [
      { status: 'APPROVED', review_mode: 'auto', hold_reason: hold },
      'pending_review',
    ]),
    [
      { status: 'APPROVED', review_mode: 'auto', hold_reason: 'payer_side_after_transfer' },
      'pending_handle',
    ],
    [
      { status: 'APPROVED', review_mode: 'manual', hold_reason: 'payer_side_after_transfer' },
      'pending_handle',
    ],
    [{ status: 'REJECTED', review_mode: 'manual', reject_reason_code: 'RISK_SUSPECT' }, 'rejected'],
    [{ status: 'REJECTED', review_mode: 'auto', reject_reason_code: 'USER_REQUEST' }, 'rejected'],
    [{ status: 'PAYING', review_mode: 'auto' }, 'paying'],
    [{ status: 'PAYING', review_mode: 'manual', needs_manual: true }, 'paying'],
    [{ status: 'PAID_API', review_mode: 'auto' }, 'paid_auto_system'],
    [{ status: 'PAID_API', review_mode: 'manual' }, 'paid_auto_review'],
    [{ status: 'PAID_API', review_mode: null }, 'paid_auto_review'],
    [{ status: 'PAID_MANUAL', review_mode: 'manual' }, 'paid_manual'],
    [
      { status: 'PAID_MANUAL', review_mode: 'auto', needs_manual: true, manual_resolution: 'paid' },
      'paid_manual',
    ],
    [{ status: 'FAILED', review_mode: 'auto', fail_code: 'PAYEE_INFO_INVALID' }, 'failed'],
    [
      { status: 'FAILED', review_mode: 'manual', needs_manual: true, manual_resolution: 'failed' },
      'failed',
    ],
  ];
  await withAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const seeded: [WithdrawalRow, string][] = [];
    for (const [index, [seed, display]] of cases.entries()) {
      const row = await seedWithdrawal(f, h, m, {
        ...seed,
        created_at: ago(f, 100 - index),
        updated_at: ago(f, 100 - index),
      });
      seeded.push([row, display]);
    }
    const data = await page(await h.list({ page_size: '200' }));
    expect(data.total).toBe(cases.length);
    const shown = new Map(
      data.items.map((item): [unknown, unknown] => [item['withdrawal_id'], item['display_status']]),
    );
    const derived = seeded.map(([row]) => [
      row.status,
      row.review_mode,
      row.hold_reason,
      shown.get(row.id),
    ]);
    expect(derived).toEqual(
      seeded.map(([row, display]) => [row.status, row.review_mode, row.hold_reason, display]),
    );
    const newest = (want: string) =>
      newestFirst(seeded.filter(([, display]) => display === want).map(([row]) => row)).map(
        (row) => row.id,
      );
    for (const display of [
      'pending_review',
      'pending_handle',
      'rejected',
      'paid_manual',
      'paid_auto_system',
      'paid_auto_review',
      'paying',
      'failed',
    ]) {
      const filtered = await page(await h.list({ display_status: display, page_size: '200' }));
      expect(filtered.total, display).toBe(newest(display).length);
      expect(
        filtered.items.map((item) => item['withdrawal_id']),
        display,
      ).toEqual(newest(display));
    }
    const handle = { status: 'APPROVED', display_status: 'pending_handle' };
    expect(await ids(await h.list(handle))).toEqual(newest('pending_handle'));
    expect(await ids(await h.list({ status: 'APPROVED', display_status: 'paying' }))).toEqual([]);
    expect(
      await ids(await h.list({ display_status: 'paid_auto_system', review_mode: 'manual' })),
    ).toEqual([]);
  });
});

it('[AC-B2-09c#5] 提现单列表的金额是整数分原样（不换算、不改符号）：amount_fen、fee_fen、tax_fen、net_fen 照存储返回，含 1 分、零手续费与 2^53−1', async () => {
  const f = fixture(s);
  await withAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const one = await seedWithdrawal(f, h, m, { amount_fen: 1n, created_at: ago(f, 3) });
    const split = await seedWithdrawal(f, h, m, {
      amount_fen: 30_000n,
      fee_fen: 100n,
      tax_fen: 2_345n,
      created_at: ago(f, 2),
    });
    const large = await seedWithdrawal(f, h, m, { amount_fen: BIG, created_at: ago(f, 1) });
    const data = await page(await h.list());
    const amounts = data.items.map((item) => [
      item['amount_fen'],
      item['fee_fen'],
      item['tax_fen'],
      item['net_fen'],
    ]);
    expect(amounts).toEqual([
      [Number(BIG), 0, 0, Number(BIG)],
      [30_000, 100, 2_345, 27_555],
      [1, 0, 0, 1],
    ]);
    expect(amounts.flat().every((value) => Number.isSafeInteger(value))).toBe(true);
    expect(data.items.map(normalize)).toEqual([large, split, one].map((row) => listView(row, m)));
  });
});

it('[AC-B2-09c#6] 提现单列表的拒绝：status、display_status、review_mode、payout_channel、hold_reason、risk_flag 不在枚举，out_biz_no 不是 1–32 位字母数字，user_id 超过 64 字符，amount_min_fen / amount_max_fen 不是非负整数，created_from / created_to 不是带时区的时刻，blocked 不是 true / false → 20001 data.fields 指名该参数；amount_min_fen > amount_max_fen → 20001 [amount_min_fen, amount_max_fen]；created_from 晚于 created_to → 20001 [created_from, created_to]；page_size 超过 200 → 20001 [page_size]；边界值照常返回', async () => {
  const f = fixture(s);
  await withAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const row = await seedWithdrawal(f, h, m, { amount_fen: 5_000n, created_at: ago(f, 10) });
    const refused = async (query: Record<string, string>, fields: string[]) => {
      await answer(await h.list(query), 20001, { fields });
    };
    await refused({ status: 'PAID' }, ['status']);
    await refused({ status: 'pending_review' }, ['status']);
    await refused({ display_status: 'PENDING_REVIEW' }, ['display_status']);
    await refused({ display_status: 'paid_auto' }, ['display_status']);
    await refused({ review_mode: 'system' }, ['review_mode']);
    await refused({ payout_channel: 'paypal' }, ['payout_channel']);
    await refused({ hold_reason: 'paused' }, ['hold_reason']);
    await refused({ risk_flag: 'blacklist' }, ['risk_flag']);
    await refused({ out_biz_no: 'W-0001' }, ['out_biz_no']);
    await refused({ out_biz_no: 'W'.repeat(33) }, ['out_biz_no']);
    await refused({ user_id: 'x'.repeat(65) }, ['user_id']);
    await refused({ amount_min_fen: '-1' }, ['amount_min_fen']);
    await refused({ amount_min_fen: 'abc' }, ['amount_min_fen']);
    await refused({ amount_max_fen: '1.5' }, ['amount_max_fen']);
    await refused({ created_from: 'yesterday' }, ['created_from']);
    await refused({ created_to: '2026-10-30' }, ['created_to']);
    await refused({ blocked: 'yes' }, ['blocked']);
    await refused({ page_size: '201' }, ['page_size']);
    const AMOUNTS = ['amount_min_fen', 'amount_max_fen'];
    await refused({ amount_min_fen: '5001', amount_max_fen: '5000' }, AMOUNTS);
    await refused({ amount_min_fen: '1', amount_max_fen: '0' }, AMOUNTS);
    const CREATED = ['created_from', 'created_to'];
    await refused(
      { created_from: withOffset(ago(f, 9)), created_to: withOffset(ago(f, 10)) },
      CREATED,
    );
    // Same instant, other offsets: 10:00+08:00 is 02:00Z, so 02:00:01Z is later.
    await refused(
      { created_from: '2026-10-30T02:00:01Z', created_to: '2026-10-30T10:00:00+08:00' },
      CREATED,
    );
    // The boundary values are accepted.
    expect(await ids(await h.list({ out_biz_no: 'A'.repeat(32), page_size: '200' }))).toEqual([]);
    expect(await ids(await h.list({ user_id: 'x'.repeat(64) }))).toEqual([]);
    expect(await ids(await h.list({ amount_min_fen: '5000', amount_max_fen: '5000' }))).toEqual([
      row.id,
    ]);
    expect(await ids(await h.list({ amount_min_fen: '0' }))).toEqual([row.id]);
    const instant = withOffset(ago(f, 10));
    expect(await ids(await h.list({ created_from: instant, created_to: instant }))).toEqual([]);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09c#7] 提现单列表的权限：既没有 withdraw.review 也没有 fund.view（无权限点，或只有 fund.recon、payout.execute、payout.manual_entry、pii.reveal_identity、pay.view 等别的点）→ 10403；不带令牌 → 10001；空应用是空页；读取不写审计、不改提现单', async () => {
  const f = fixture(s);
  const empty = fixture(s);
  await withAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const row = await seedWithdrawal(f, h, m, { created_at: ago(f, 1) });
    const before = await footprint(f);
    await answer(await h.list({}, await h.caller([])), 10403);
    await answer(await h.list({}, await h.caller(['fund.recon'])), 10403);
    await answer(
      await h.list({}, await h.caller(['payout.execute', 'payout.manual_entry'])),
      10403,
    );
    await answer(await h.list({}, await h.caller(['pii.reveal_identity', 'pay.view'])), 10403);
    await answer(await h.list({}, null), 10001);
    expect(await ids(await h.list())).toEqual([row.id]);
    expect(await ids(await h.list({}, h.viewer))).toEqual([row.id]);
    expect(await footprint(f)).toEqual(before);
  });
  await withAdmin(empty, async (h) => {
    expect(await page(await h.list({}, h.viewer))).toEqual({
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
    });
  });
  expect(await allAudits(f)).toEqual([]);
  expect(await allAudits(empty)).toEqual([]);
});

it('[AC-B2-09c#8] 提现单列表不出收款信息（BR-ID-33）：行里没有收款账号与姓名，应答正文任何位置都不含收款人姓名、收款账号明文（支付宝手机号 / 邮箱、银行卡号、微信 openid）、账号密文与盲索引、用户完整手机号；手机号只出 3+4', async () => {
  const f = fixture(s);
  await withAdmin(f, async (h) => {
    const a = await seedMember(f, h, '13912340001');
    const b = await seedMember(f, h);
    const seeds: [WithdrawalSeed & { readonly account: string }, typeof a][] = [
      [{ method: 'alipay', account: '13800005678' }, a],
      [{ method: 'alipay', account: ACCOUNT.alipay }, b],
      [{ method: 'bank_card', account: '6222020200112233445' }, a],
      [{ method: 'wechat', account: ACCOUNT.wechat }, b],
    ];
    const secrets: string[] = [];
    for (const [index, [seed, member]] of seeds.entries()) {
      const row = await seedWithdrawal(f, h, member, {
        ...seed,
        payee_name: index % 2 === 0 ? '合成甲' : '测试乙',
        created_at: ago(f, 10 - index),
      });
      secrets.push(...secretsOf(row, seed.account, member));
    }
    const sent = await h.list();
    const data = await page(sent);
    expect(data.total).toBe(4);
    for (const item of data.items) {
      expect(Object.keys(item).sort()).toEqual([...LIST_KEYS]);
      const user = item['user'] as { user_id: string; phone_masked: string | null };
      expect(user.phone_masked).toBe(user.user_id === a.userId ? '139****0001' : b.phoneMasked);
    }
    expectNoSecrets(sent.body, secrets);
    expectNoSecrets(sent.body, ['**甲', '**乙', '138****5678', '尾号 3445']);
  });
});
