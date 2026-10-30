// B2-09f confirm rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// confirmAdminSettleBill (POST /admin/v1/settle-bills/{bill_id}/confirm); 08 BR-FUND-04 ⑥, 迁移表
// SB2; 编排裁定 D10-444: one confirmation covers every DRAFT batch of the bill, whatever its round
// and platform, expected_batches matching them one to one (at most 1000 entries). settle_mode
// IMMEDIATE when absent; scheduled_at required with SCHEDULED, not allowed with IMMEDIATE, later
// than the moment of confirmation and outside the nominal asset snapshot window, else 20001
// [scheduled_at], checked again after the locks. Order of checks after the guard: body → bill_id
// (20001 [bill_id], no 404) → still generating (20001 [bill_id] reason bill_not_ready) → 20902
// resource=settle_batch. Effects in one transaction: each DRAFT to CONFIRMED by compare-and-set
// (row_version + 1) with settle_mode, scheduled_at, confirmed_by the caller, confirmed_at the server
// clock; no money moves; audit settle_bill_confirm. The response is the bill as GET returns it
// afterwards. Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CONFIRM_ACTION,
  GENERATING,
  ago,
  allBatches,
  answer,
  audits,
  auditText,
  batchNow,
  billOf,
  billView,
  batchesOf,
  conflict,
  counts,
  everything,
  expected,
  fixture,
  holdBill,
  inDetailOrder,
  instantsIn,
  later,
  oneAudit,
  refused,
  seedBatch,
  seedBill,
  seedOrderItem,
  shown,
  suite,
  track,
  versionOf,
  waiting,
  withCommandsAdmin,
  type BatchRow,
  type Fixture,
} from './kit.ts';

const s = suite();

/** The row of `before` after SB2 by `adminId` at the fixture's clock; nothing else changes. */
function confirmed(
  f: Fixture,
  before: BatchRow,
  adminId: string,
  mode: 'IMMEDIATE' | 'SCHEDULED',
  scheduledAt: Date | null,
): BatchRow {
  return {
    ...before,
    status: 'CONFIRMED',
    settle_mode: mode,
    scheduled_at: scheduledAt,
    confirmed_by: adminId,
    confirmed_at: f.clock.now(),
    row_version: before.row_version + 1,
  };
}

it('[AC-B2-09f#7] 确认立即结算（settle_mode 缺省即 IMMEDIATE）：账单下全部 DRAFT（不分平台与轮次）一次到 CONFIRMED，row_version 各 +1，confirmed_by 为操作人，confirmed_at 为服务端时钟；已结束或已确认的批次、别的账单的 DRAFT 不动；明细、账单合计与账务不动；响应恰好是之后 GET 详情的内容，账单派生为 settling；写一条审计 settle_bill_confirm，含账单、结算方式和每个批次确认前后的状态', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const taobao = await seedBatch(f, bill, { row_version: 2, order_count: 3 });
  const jd = await seedBatch(f, bill, { platform: 'jd', row_version: 5 });
  const supplement = await seedBatch(f, bill, {
    kind: 'supplement',
    platform: 'pdd',
    created_at: ago(f, 60),
  });
  const done = await seedBatch(f, bill, { platform: 'pdd', status: 'DONE' });
  const cancelled = await seedBatch(f, bill, { platform: 'jd', status: 'CANCELLED' });
  const scheduled = await seedBatch(f, bill, {
    platform: 'vip',
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
  });
  const elsewhere = await seedBatch(f, await seedBill(f, '2026-08'));
  await seedOrderItem(f, taobao);
  const drafts = [taobao, jd, supplement];
  await withCommandsAdmin(f, async (h) => {
    f.clock.set(later(f, 3));
    const before = await everything(f);
    const sent = await h.confirm(bill.bill_id, { expected_batches: expected(drafts) });
    const data = await billOf(sent);

    const rows = new Map(
      drafts.map((b) => [b.batch_id, confirmed(f, b, h.biller.id, 'IMMEDIATE', null)]),
    );
    for (const batch of drafts) {
      expect(await batchNow(f, batch)).toEqual(rows.get(batch.batch_id));
    }
    for (const batch of [done, cancelled, scheduled, elsewhere]) {
      expect(await batchNow(f, batch)).toEqual(batch);
    }
    const after = await everything(f);
    const { audits: recorded, batches, ...rest } = after;
    expect(rest).toEqual({
      bills: before.bills,
      items: before.items,
      orders: before.orders,
      jobs: before.jobs,
      diffs: before.diffs,
      vouchers: before.vouchers,
      balances: before.balances,
      idempotency: before.idempotency,
    });
    expect(batches).toHaveLength(before.batches.length);
    expect(recorded).toHaveLength(1);

    const all = [...rows.values(), done, cancelled, scheduled];
    expect(data).toEqual({
      ...billView(bill, 'settling', all),
      batches: inDetailOrder(all).map((b) =>
        shown(
          b,
          b.batch_id === supplement.batch_id,
          b.batch_id === taobao.batch_id ? counts({ order: { pending: 1 } }) : counts(),
        ),
      ),
    });
    expect(await billOf(await h.detail(bill.bill_id))).toEqual(data);
    expect(data['draft_batch_count']).toBe(0);

    const record = await oneAudit(f, CONFIRM_ACTION, h.biller.id);
    const text = auditText(record);
    for (const value of [bill.bill_id, 'IMMEDIATE', ...drafts.map((b) => b.batch_id)]) {
      expect(text).toContain(value);
    }
    expect(JSON.stringify(record.before)).toContain('"DRAFT"');
    expect(JSON.stringify(record.after)).toContain('"CONFIRMED"');
  });
});

it('[AC-B2-09f#8] 定时结算：SCHEDULED 带 scheduled_at（带时区偏移的写法按同一瞬间存），恰好 00:30:00 已不在快照时段内可以保存；批次记 settle_mode SCHEDULED 与 scheduled_at，账单派生为 scheduled；settle_mode 明写 IMMEDIATE 与缺省等价；审计含结算方式与定时时刻', async () => {
  const f = fixture(s);
  const at = '2026-10-31T00:30:00+08:00';
  const bill = await seedBill(f, '2026-09');
  const taobao = await seedBatch(f, bill);
  const jd = await seedBatch(f, bill, { platform: 'jd', row_version: 1 });
  const plain = await seedBill(f, '2026-08');
  const immediate = await seedBatch(f, plain);
  await withCommandsAdmin(f, async (h) => {
    const data = await billOf(
      await h.confirm(bill.bill_id, {
        expected_batches: expected([taobao, jd]),
        settle_mode: 'SCHEDULED',
        scheduled_at: at,
      }),
    );
    for (const batch of [taobao, jd]) {
      expect(await batchNow(f, batch)).toEqual(
        confirmed(f, batch, h.biller.id, 'SCHEDULED', new Date(at)),
      );
    }
    expect(data['status']).toBe('scheduled');
    const record = await oneAudit(f, CONFIRM_ACTION, h.biller.id);
    expect(auditText(record)).toContain('SCHEDULED');
    expect(instantsIn(auditText(record))).toContain(Date.parse(at));

    await answer(
      await h.confirm(plain.bill_id, {
        expected_batches: expected([immediate]),
        settle_mode: 'IMMEDIATE',
      }),
      0,
    );
    expect(await batchNow(f, immediate)).toEqual(
      confirmed(f, immediate, h.biller.id, 'IMMEDIATE', null),
    );
  });
});

it('[AC-B2-09f#9] 确认覆盖不在最近一轮的 DRAFT（D10-444）：撤销定时回到 DRAFT 的首批在后来的补充轮之外（in_current_round false），账单派生甚至是 settled；再确认必须连它一起，只报最近一轮的 DRAFT → 20902；连它一起确认后账单下不再有 DRAFT，不悬空', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const scheduled = await seedBatch(f, bill, {
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
    row_version: 1,
  });
  const executed = await seedBatch(f, bill, {
    kind: 'supplement',
    status: 'DONE',
    created_at: ago(f, 60),
  });
  await withCommandsAdmin(f, async (h) => {
    const back = (await batchesOf(await h.cancelSchedule(scheduled.batch_id, versionOf(scheduled))))
      .filter((b) => b['batch_id'] === scheduled.batch_id)
      .map((b) => ({ status: b['status'], in_current_round: b['in_current_round'] }));
    expect(back).toEqual([{ status: 'DRAFT', in_current_round: false }]);
    const detail = await billOf(await h.detail(bill.bill_id));
    expect({ status: detail['status'], drafts: detail['draft_batch_count'] }).toEqual({
      status: 'settled',
      drafts: 1,
    });

    // A later launch adds a DRAFT of the latest round: the old DRAFT still has to come along.
    const latest = await seedBatch(f, bill, {
      kind: 'supplement',
      platform: 'jd',
      created_at: ago(f, 30),
    });
    const draft = await batchNow(f, scheduled);
    await conflict(await h.confirm(bill.bill_id, { expected_batches: expected([latest]) }));
    await conflict(await h.confirm(bill.bill_id, { expected_batches: expected([draft]) }));
    expect(await batchNow(f, draft)).toEqual(draft);
    expect(await batchNow(f, latest)).toEqual(latest);

    const data = await billOf(
      await h.confirm(bill.bill_id, { expected_batches: expected([draft, latest]) }),
    );
    expect(data['draft_batch_count']).toBe(0);
    expect(await batchNow(f, draft)).toEqual(confirmed(f, draft, h.biller.id, 'IMMEDIATE', null));
    expect(await batchNow(f, latest)).toEqual(confirmed(f, latest, h.biller.id, 'IMMEDIATE', null));
    expect(await batchNow(f, executed)).toEqual(executed);
    expect(await allBatches(f)).toHaveLength(3);
  });
});

it('[AC-B2-09f#10] 请求体：缺 expected_batches、不是数组、超过 1000 条 → 20001 [expected_batches]；条目缺字段或 expected_row_version 为负 → 20001 指名该条该字段；settle_mode 不在枚举 → [settle_mode]；scheduled_at 不是日期时间 → [scheduled_at]；未知字段 → 该字段；什么都不变、不写审计', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const draft = await seedBatch(f, bill);
  const entry = { batch_id: draft.batch_id, expected_row_version: 0 };
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const send = (body: unknown) => h.confirm(bill.bill_id, body);
    await refused(await send({}), ['expected_batches']);
    await refused(await send({ expected_batches: 'all' }), ['expected_batches']);
    await refused(await send({ expected_batches: Array.from({ length: 1001 }, () => entry) }), [
      'expected_batches',
    ]);
    await refused(await send({ expected_batches: [{ batch_id: draft.batch_id }] }), [
      'expected_batches.0.expected_row_version',
    ]);
    await refused(await send({ expected_batches: [{ expected_row_version: 0 }] }), [
      'expected_batches.0.batch_id',
    ]);
    await refused(await send({ expected_batches: [{ ...entry, expected_row_version: -1 }] }), [
      'expected_batches.0.expected_row_version',
    ]);
    await refused(await send({ expected_batches: [entry], settle_mode: 'LATER' }), ['settle_mode']);
    await refused(
      await send({
        expected_batches: [entry],
        settle_mode: 'SCHEDULED',
        scheduled_at: 'tomorrow',
      }),
      ['scheduled_at'],
    );
    await refused(await send({ expected_batches: [entry], note: '备注' }), ['note']);
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09f#11] 结算方式与定时时刻：SCHEDULED 不带时刻、IMMEDIATE 或缺省却带时刻、时刻不晚于确认时刻（过去、恰好此刻）、落在快照名义时段（00:00、00:29:59.999）→ 20001 data.fields=[scheduled_at]，先于 bill_id（未知账单、生成中账单同样先报它）与 expected_batches 集合；什么都不变、不写审计', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const draft = await seedBatch(f, bill);
  await seedBill(f, '2026-08', GENERATING);
  const expected_batches = expected([draft]);
  const now = f.clock.now();
  const schedule = (scheduled_at: string) => ({
    expected_batches,
    settle_mode: 'SCHEDULED',
    scheduled_at,
  });
  const bad = [
    { expected_batches, settle_mode: 'SCHEDULED' },
    { expected_batches, settle_mode: 'IMMEDIATE', scheduled_at: later(f, 60).toISOString() },
    { expected_batches, scheduled_at: later(f, 60).toISOString() },
    schedule(ago(f, 1).toISOString()),
    schedule(now.toISOString()),
    schedule('2026-10-31T00:00:00+08:00'),
    schedule('2026-10-31T00:29:59.999+08:00'),
  ];
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    for (const body of bad) {
      await refused(await h.confirm(bill.bill_id, body), ['scheduled_at']);
      await refused(await h.confirm('2020-01', body), ['scheduled_at']);
      await refused(await h.confirm('2026-08', body), ['scheduled_at']);
      await refused(await h.confirm(bill.bill_id, { ...body, expected_batches: [] }), [
        'scheduled_at',
      ]);
    }
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09f#12] 账单 id：不是 YYYY-MM、本应用没有该账单 → 20001 data.fields=[bill_id]（不回 404、不带 reason，未知账单的应答一样）；还在生成中的账单 → 20001 [bill_id] data.reason=bill_not_ready，先于 expected_batches 集合；什么都不变、不写审计', async () => {
  const f = fixture(s);
  const generating = await seedBill(f, '2026-09', GENERATING);
  const draft = await seedBatch(f, generating);
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const replies: unknown[] = [];
    for (const billId of ['2026-08', '2026-10', '1999-01']) {
      const body = await refused(await h.confirm(billId, { expected_batches: [] }), ['bill_id']);
      replies.push({ code: body.code, msg: body.msg, data: body.data });
    }
    expect(new Set(replies.map((reply) => JSON.stringify(reply))).size).toBe(1);
    for (const billId of ['2026-13', '2026-00', '2026-9', '202609']) {
      await refused(await h.confirm(billId, { expected_batches: [] }), ['bill_id']);
    }
    for (const list of [[], expected([draft])]) {
      await refused(
        await h.confirm(generating.bill_id, { expected_batches: list }),
        ['bill_id'],
        'bill_not_ready',
      );
    }
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09f#13] expected_batches 与账单 DRAFT 集合不是一一对应 → 20902 data.resource=settle_batch，什么都不变：少一条、空列表、重复一条、多一条（非 DRAFT、别的账单的、不存在的、不是 UUID 的）、版本过期（偏大或偏小）；账单没有 DRAFT 时任何列表（含空列表）都是 20902；不写审计', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const a = await seedBatch(f, bill, { row_version: 1 });
  const b = await seedBatch(f, bill, { platform: 'jd', row_version: 1 });
  const confirmedBatch = await seedBatch(f, bill, { platform: 'pdd', status: 'CONFIRMED' });
  const other = await seedBill(f, '2026-08');
  const otherDraft = await seedBatch(f, other);
  const settled = await seedBill(f, '2026-07');
  const finished = await seedBatch(f, settled, { status: 'DONE' });
  const empty = await seedBill(f, '2026-06');
  const both = expected([a, b]);
  const stale = (delta: number) => [
    both[0]!,
    { ...both[1]!, expected_row_version: both[1]!.expected_row_version + delta },
  ];
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const sets: unknown[][] = [
      [both[0]],
      [],
      [...both, both[0]],
      [...both, ...expected([confirmedBatch])],
      [...both, ...expected([otherDraft])],
      [...both, { batch_id: randomUUID(), expected_row_version: 0 }],
      [...both, { batch_id: 'not-a-uuid', expected_row_version: 0 }],
      stale(1),
      stale(-1),
    ];
    for (const expected_batches of sets) {
      await conflict(await h.confirm(bill.bill_id, { expected_batches }));
    }
    await conflict(await h.confirm(settled.bill_id, { expected_batches: [] }));
    await conflict(await h.confirm(settled.bill_id, { expected_batches: expected([finished]) }));
    await conflict(await h.confirm(empty.bill_id, { expected_batches: [] }));
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09f#14] 比较并交换：同一请求再提交 → 20902，批次保持第一次的结果、审计一条；两个请求同时确认同一账单 → 恰好一个成功、另一个 20902，row_version 只加一次', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const draft = await seedBatch(f, bill);
  const racing = await seedBill(f, '2026-08');
  const contested = await seedBatch(f, racing);
  await withCommandsAdmin(f, async (h) => {
    const body = { expected_batches: expected([draft]) };
    await answer(await h.confirm(bill.bill_id, body), 0);
    const once = await batchNow(f, draft);
    await conflict(await h.confirm(bill.bill_id, body));
    expect(await batchNow(f, draft)).toEqual(once);
    expect(await audits(f, CONFIRM_ACTION)).toHaveLength(1);

    const race = { expected_batches: expected([contested]) };
    const replies = await Promise.all([
      h.confirm(racing.bill_id, race),
      h.confirm(racing.bill_id, race),
    ]);
    expect(replies.map((sent) => sent.json().code).sort((x, y) => x - y)).toEqual([0, 20902]);
    await conflict(replies.find((sent) => sent.json().code === 20902)!);
    expect((await batchNow(f, contested)).row_version).toBe(contested.row_version + 1);
    expect(await audits(f, CONFIRM_ACTION)).toHaveLength(2);
  });
});

it('[AC-B2-09f#15] 确认时刻取在锁之后：请求在账单行锁上等待期间时钟走过了定时时刻 → 20001 [scheduled_at]，什么都不变；立即结算等待后 confirmed_at 取放锁之后的服务端时刻', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const draft = await seedBatch(f, bill);
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const held = await holdBill(f, bill.bill_id);
    const scheduled = track(
      h.confirm(bill.bill_id, {
        expected_batches: expected([draft]),
        settle_mode: 'SCHEDULED',
        scheduled_at: later(f, 5).toISOString(),
      }),
    );
    try {
      expect(await waiting(f, 1, [scheduled]), '确认应在账单行锁上等待').toBe(true);
      f.clock.set(later(f, 6));
    } finally {
      await held.release();
    }
    await refused(await scheduled.promise, ['scheduled_at']);
    expect(await everything(f)).toEqual(before);

    const again = await holdBill(f, bill.bill_id);
    const immediate = track(h.confirm(bill.bill_id, { expected_batches: expected([draft]) }));
    try {
      expect(await waiting(f, 1, [immediate]), '确认应在账单行锁上等待').toBe(true);
      f.clock.set(later(f, 9));
    } finally {
      await again.release();
    }
    await answer(await immediate.promise, 0);
    expect(await batchNow(f, draft)).toEqual(confirmed(f, draft, h.biller.id, 'IMMEDIATE', null));
  });
});
