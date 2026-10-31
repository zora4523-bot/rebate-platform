// B2-09g restore rule tests, the effects (claude-independent, SPEC_REF 81273415):
// contracts/openapi.yaml restoreAdminReconDiff and 08 BR-FUND-22 ③ — for each role of
// resolution.shares an active beneficiary event after the forfeited one; floor(booked_base_fen ×
// ratio_bp / 10000) of the snapshot less the role's net (BR-FUND-08) as ADMIN_ADJUST (RESTORE),
// debit COMMISSION_REVENUE / credit the member's available, uniq_key
// `{order_key}:{user_id}:{role}:RESTORE:{recon_diff_id}`; never expected_fen, the FORFEIT voucher's
// amount, the snapshot's amounts or the current settled commission; the net counts every voucher
// kind of BR-FUND-08; a PUNISH clawback leaves nothing to restore. D10-469: ② a member banned again
// is still paid; ③ a difference ≤ 0 posts nothing, pays 0, takes nothing back and the difference is
// still handled. The difference adjusted (handler the caller, closed_at = updated_at = the server
// clock, the three amounts as registered, resolution keeps its keys and adds restore and the
// trimmed note); audit recon_diff_restore; rebate_status and withdrawal holds untouched. Expected
// amounts are written by hand. Requests go through the real admin entry (kit.ts). Top-level it()
// only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  DETAIL_KEYS,
  FORFEITED_AT,
  RESTORE_ACTION,
  answer,
  audits,
  available,
  detailView,
  diffNow,
  everything,
  expectRestored,
  fixture,
  holdNow,
  memberOf,
  netOf,
  netsOf,
  normalize,
  restoreKey,
  restoreLines,
  restoreVouchers,
  restored,
  seedCase,
  seedHold,
  seedOrder,
  seedRestoreDiff,
  setCooling,
  setRisk,
  shareEvents,
  sourceOf,
  suite,
  voucherLines,
  withRestoreAdmin,
  type Case,
  type NetStep,
  type Role,
} from './kit.ts';

const s = suite();

it('[AC-B2-09g#9] BR-FUND-22 例：直推上级入账时被封禁，份额 123 计入平台留存；处理后写 ADMIN_ADJUST(RESTORE)：借 COMMISSION_REVENUE 123 / 贷 USER_BALANCE:U 123，uniq_key `{order_key}:{user_id}:{role}:RESTORE:{差错单 id}`，凭证挂受益人键；应答为处理后的详情与 restored_fen 123；差错单 adjusted，resolution 保留原键并加 restore 与去空白的 note', async () => {
  const f = await fixture(s);
  // N = 1450, reserve 1500 → booked_base_fen 1232; direct 1000 → floor(123.2) = 123.
  const c = await seedCase(f, { settleFen: 1450n });
  await withRestoreAdmin(f, async (h) => {
    const note = '  封禁申诉已撤销，核对后补发\t\n';
    const sent = await h.restore(c.diff.id, { note });
    const data = await restored(sent);

    expect(data.restored_fen).toBe(123);
    const after = await expectRestored(f, c.diff, {
      adminId: h.operator.id,
      paid: { direct: 123n },
      note: note.trim(),
    });
    expect(after.expected_fen).toBe(c.diff.expected_fen);
    expect(after.actual_fen).toBe(0n);
    expect(after.diff_fen).toBe(c.diff.diff_fen);
    expect(Object.keys(data.recon_diff).sort(), sent.body).toEqual(DETAIL_KEYS);
    expect(data.recon_diff, sent.body).toEqual(detailView(after));

    const key = restoreKey(c.order.orderKey, c.userId, 'direct', c.diff.id);
    expect(await voucherLines(f, key)).toEqual(restoreLines(c.userId, 123n));
    const vouchers = await restoreVouchers(f);
    expect(vouchers.map((v) => v.uniq_key)).toEqual([key]);
    expect(vouchers[0]).toMatchObject({
      order_key: c.order.orderKey,
      beneficiary_user_id: c.userId,
      role: 'direct',
      voucher_kind: 'ADMIN_ADJUST',
    });
    expect(vouchers[0]!.operator).toContain(h.operator.id);
    expect(await available(f, c.userId)).toBe(123n);
  });
});

it('[AC-B2-09g#10] 金额现算：按 booked_base_fen 与快照比例，不取差错单登记额、FORFEIT 凭证额、快照金额或当前结算佣金。expected_fen 被改大（85 → 999999）实发仍 85；订单基数已升（N 1200 → 1020，份额 102，凭证 85）实发 102；基数已降（N 500 → 425，份额 42，凭证 85）实发 42；新结算额 1200 待批准、booked_base_fen 仍 850（BR-FUND-09）实发 85，不是 R13 口径的 102；差错单三个金额都按登记不变', async () => {
  const f = await fixture(s);
  const inflatedOrder = await seedOrder(f);
  const inflated = await seedRestoreDiff(f, inflatedOrder, {
    patch: { expected_fen: 999_999n, diff_fen: 999_999n },
  });
  const unbooked = await seedCase(f, { newSettleFen: 1200n });
  const raised = await seedCase(f, {
    settleFen: 1200n,
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, forfeited: true, forfeitFen: 85n },
      { role: 'indirect', ratioBp: 500 },
    ],
  });
  const lowered = await seedCase(f, {
    settleFen: 500n,
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, forfeited: true, forfeitFen: 85n },
      { role: 'indirect', ratioBp: 500 },
    ],
  });
  const rows = [
    { diff: inflated, order: inflatedOrder, fen: 85n },
    { diff: raised.diff, order: raised.order, fen: 102n },
    { diff: lowered.diff, order: lowered.order, fen: 42n },
    { diff: unbooked.diff, order: unbooked.order, fen: 85n },
  ];
  await withRestoreAdmin(f, async (h) => {
    for (const { diff, order, fen } of rows) {
      const userId = order.user('direct');
      const data = await restored(await h.restore(diff.id));
      expect(data.restored_fen).toBe(Number(fen));
      const after = await expectRestored(f, diff, {
        adminId: h.operator.id,
        paid: { direct: fen },
      });
      expect(after.expected_fen).toBe(diff.expected_fen);
      expect(after.diff_fen).toBe(diff.diff_fen);
      expect(await voucherLines(f, restoreKey(order.orderKey, userId, 'direct', diff.id))).toEqual(
        restoreLines(userId, fen),
      );
      expect(await available(f, userId)).toBe(fen);
    }
  });
});

it('[AC-B2-09g#11] 与已入账净额之差（BR-FUND-08）：该角色已入账 40、应得 85 → 补 45；取整只向下：基数 999 × 1234 bp = 123.27 → 123，基数 1 × 3333 bp → 应得 0、不写分录', async () => {
  const f = await fixture(s);
  const partial = await seedCase(f, {
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, forfeited: true, creditedFen: 40n },
    ],
  });
  // reserve_bp 0: booked_base_fen = N.
  const rounded = await seedCase(f, {
    settleFen: 999n,
    reserveBp: 0,
    people: [{ role: 'direct', ratioBp: 1234, forfeited: true }],
  });
  const dust = await seedCase(f, {
    settleFen: 1n,
    reserveBp: 0,
    people: [{ role: 'direct', ratioBp: 3333, forfeited: true, forfeitFen: 1n }],
  });
  await withRestoreAdmin(f, async (h) => {
    expect((await restored(await h.restore(partial.diff.id))).restored_fen).toBe(45);
    const key = restoreKey(partial.order.orderKey, partial.userId, 'direct', partial.diff.id);
    expect(await voucherLines(f, key)).toEqual(restoreLines(partial.userId, 45n));
    expect(await available(f, partial.userId)).toBe(85n);

    expect((await restored(await h.restore(rounded.diff.id))).restored_fen).toBe(123);
    expect(await available(f, rounded.userId)).toBe(123n);

    expect((await restored(await h.restore(dust.diff.id))).restored_fen).toBe(0);
    expect(await available(f, dust.userId)).toBe(0n);
    await expectRestored(f, dust.diff, { adminId: h.operator.id, paid: { direct: 0n } });
  });
});

it('[AC-B2-09g#12] 多角色：同一会员在同一子订单上 share 与 direct 都被没收 → 各一条 ADMIN_ADJUST(RESTORE)，键按角色区分，借 COMMISSION_REVENUE / 贷该受益人 available；restored_fen 为合计 510，resolution.restore 逐角色列明', async () => {
  const f = await fixture(s);
  const userId = await memberOf(f);
  const c = await seedCase(f, {
    people: [
      { role: 'share', ratioBp: 5000, userId, forfeited: true },
      { role: 'direct', ratioBp: 1000, userId, forfeited: true },
      { role: 'indirect', ratioBp: 500 },
    ],
  });
  await withRestoreAdmin(f, async (h) => {
    const data = await restored(await h.restore(c.diff.id));
    expect(data.restored_fen).toBe(510);
    await expectRestored(f, c.diff, {
      adminId: h.operator.id,
      paid: { share: 425n, direct: 85n },
    });
    const share = restoreKey(c.order.orderKey, userId, 'share', c.diff.id);
    const direct = restoreKey(c.order.orderKey, userId, 'direct', c.diff.id);
    expect((await restoreVouchers(f)).map((v) => v.uniq_key).sort()).toEqual(
      [share, direct].sort(),
    );
    expect(await voucherLines(f, share)).toEqual(restoreLines(userId, 425n));
    expect(await voucherLines(f, direct)).toEqual(restoreLines(userId, 85n));
    expect(await available(f, userId)).toBe(510n);
  });
});

it('[AC-B2-09g#13] 复式平衡与范围：只动差错单列出的角色——该受益人净额 +85、平台净额 −85、应收联盟净额不变（BR-FUND-19 ⑤）；同单别的受益人净额与余额不变；同一会员未列出的被没收角色不补、不加事件', async () => {
  const f = await fixture(s);
  const userId = await memberOf(f);
  const order = await seedOrder(f, {
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, userId, forfeited: true },
      { role: 'indirect', ratioBp: 500, userId, forfeited: true },
    ],
  });
  const diff = await seedRestoreDiff(f, order, { roles: ['direct'] });
  const buyer = order.user('self');
  const before = await netsOf(f, order.orderKey);
  const eventsBefore = await shareEvents(f, order.orderId);
  await withRestoreAdmin(f, async (h) => {
    expect((await restored(await h.restore(diff.id))).restored_fen).toBe(85);

    const after = await netsOf(f, order.orderKey);
    expect(netOf(after, userId, 'direct')).toBe(netOf(before, userId, 'direct') + 85n);
    expect(netOf(after, userId, 'indirect')).toBe(netOf(before, userId, 'indirect'));
    expect(netOf(after, buyer, 'self')).toBe(netOf(before, buyer, 'self'));
    expect(after.platform_net_fen).toBe(before.platform_net_fen - 85n);
    expect(after.union_receivable_net_fen).toBe(before.union_receivable_net_fen);
    expect(await available(f, buyer)).toBe(425n);

    const added = (await shareEvents(f, order.orderId)).slice(eventsBefore.length);
    expect(added.map((e) => [e.user_id, e.role, e.status])).toEqual([[userId, 'direct', 'active']]);
  });
});

it('[AC-B2-09g#14] 依 D10-469 ③：重算差额 ≤ 0 不写分录：净额正好等于应得（85 / 85）、净额大于应得（100 / 85，负差不扣回）→ restored_fen 0，余额不变，差错单照样 adjusted、resolution.restore 记 0、active 事件照追加，审计 restored_fen 为 0', async () => {
  const f = await fixture(s);
  const even = await seedCase(f, {
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, forfeited: true, creditedFen: 85n, forfeitFen: 5n },
    ],
  });
  const over = await seedCase(f, {
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, forfeited: true, creditedFen: 100n, forfeitFen: 5n },
    ],
  });
  await withRestoreAdmin(f, async (h) => {
    for (const [c, balance] of [
      [even, 85n],
      [over, 100n],
    ] as const) {
      const eventsBefore = await shareEvents(f, c.order.orderId);
      const data = await restored(await h.restore(c.diff.id));
      expect(data.restored_fen).toBe(0);
      await expectRestored(f, c.diff, { adminId: h.operator.id, paid: { direct: 0n } });
      expect(await available(f, c.userId)).toBe(balance);
      const added = (await shareEvents(f, c.order.orderId)).slice(eventsBefore.length);
      expect(added.map((e) => [e.user_id, e.role, e.status])).toEqual([
        [c.userId, 'direct', 'active'],
      ]);
    }
    expect(await restoreVouchers(f)).toEqual([]);
    const records = await audits(f, RESTORE_ACTION);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(JSON.stringify(record.after)).toMatch(/"restored_fen":"?0"?[,}]/);
    }
  });
});

it('[AC-B2-09g#15] 依 D10-469 ③：两个角色一正一负：正的写一条，负的 0、不扣回；restored_fen 为正差之和，不与负差相抵', async () => {
  const f = await fixture(s);
  const userId = await memberOf(f);
  const c = await seedCase(f, {
    people: [
      { role: 'share', ratioBp: 5000, userId, forfeited: true },
      { role: 'direct', ratioBp: 1000, userId, forfeited: true, creditedFen: 100n, forfeitFen: 5n },
    ],
  });
  await withRestoreAdmin(f, async (h) => {
    expect((await restored(await h.restore(c.diff.id))).restored_fen).toBe(425);
    await expectRestored(f, c.diff, {
      adminId: h.operator.id,
      paid: { share: 425n, direct: 0n },
    });
    expect((await restoreVouchers(f)).map((v) => v.uniq_key)).toEqual([
      restoreKey(c.order.orderKey, userId, 'share', c.diff.id),
    ]);
    expect(await available(f, userId)).toBe(525n);
  });
});

it('[AC-B2-09g#16] 依 D10-469 ②：受益人又被新一轮封禁仍补发；其余状态（冻结、申诉中、注销冷静期）同样补发（12 §4.8：只有注销处理与已注销不写账户，BR-CALC-13：冷静期不算失效）；风控状态不变', async () => {
  const f = await fixture(s);
  const banned = await seedCase(f);
  await setRisk(f, banned.userId, 'banned');
  const frozen = await seedCase(f);
  await setRisk(f, frozen.userId, 'frozen');
  const appealing = await seedCase(f);
  await setRisk(f, appealing.userId, 'appealing');
  const cooling = await seedCase(f);
  await setCooling(f, cooling.userId);
  await withRestoreAdmin(f, async (h) => {
    const before = await everything(f);
    for (const c of [banned, frozen, appealing, cooling]) {
      expect((await restored(await h.restore(c.diff.id))).restored_fen).toBe(85);
      expect(await available(f, c.userId)).toBe(85n);
    }
    expect((await everything(f)).risk).toEqual(before.risk);
  });
});

it('[AC-B2-09g#17] active 事件：每个列出的角色在 forfeited 事件之后追加一条 active（reason 空、created_at 为服务端时间），只追加、不改已有事件', async () => {
  const f = await fixture(s);
  const userId = await memberOf(f);
  const c = await seedCase(f, {
    people: [
      { role: 'share', ratioBp: 5000, userId, forfeited: true },
      { role: 'direct', ratioBp: 1000, userId, forfeited: true },
    ],
  });
  const before = await shareEvents(f, c.order.orderId);
  expect(before.map((e) => e.status)).toEqual(['active', 'forfeited', 'active', 'forfeited']);
  await withRestoreAdmin(f, async (h) => {
    await restored(await h.restore(c.diff.id));
    const after = await shareEvents(f, c.order.orderId);
    expect(after.slice(0, before.length)).toEqual(before);
    const added = after.slice(before.length);
    expect(added).toHaveLength(2);
    expect(added.map((e) => e.role).sort()).toEqual(['direct', 'share']);
    for (const event of added) {
      expect(event).toMatchObject({
        app_id: f.appId,
        order_id: c.order.orderId,
        user_id: userId,
        status: 'active',
        reason: null,
        created_at: f.clock.now(),
      });
      expect(event.created_at.getTime()).toBeGreaterThan(FORFEITED_AT.getTime());
    }
  });
});

it('[AC-B2-09g#18] 审计 recon_diff_restore 恰一条：操作人、目标为差错单，含 user_id、order_key、各角色实发、restored_fen 与前后状态，无个人信息', async () => {
  const f = await fixture(s);
  const userId = await memberOf(f);
  const c = await seedCase(f, {
    people: [
      { role: 'share', ratioBp: 5000, userId, forfeited: true },
      { role: 'direct', ratioBp: 1000, userId, forfeited: true },
    ],
  });
  await withRestoreAdmin(f, async (h) => {
    await restored(await h.restore(c.diff.id, { note: '核对后补发' }));
    const records = await audits(f, RESTORE_ACTION);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.admin_id).toBe(h.operator.id);
    expect(record.target).toBe(c.diff.id);
    const before = JSON.stringify(record.before);
    const after = JSON.stringify(record.after);
    expect(before).toContain('"open"');
    expect(after).toContain('"adjusted"');
    const both = `${before}${after}`;
    expect(both).toContain(userId);
    expect(both).toContain(c.order.orderKey);
    expect(after).toMatch(/"restored_fen":"?510"?[,}]/);
    expect(after).toContain('"share"');
    expect(after).toContain('"direct"');
    // Ids hold digits too: the amounts of the roles are looked for without them.
    const amounts = [userId, c.order.orderKey, c.diff.id, h.operator.id].reduce(
      (text, id) => text.replaceAll(id, ''),
      after,
    );
    expect(amounts).toMatch(/\b425\b/);
    expect(amounts).toMatch(/\b85\b/);
    expect(both).not.toContain('synthetic');
  });
});

it('[AC-B2-09g#19] 别的都不动：订单行（rebate_status、booked_base_fen、row_version 等）一字不改；提现冻结不解除（同源冻结也不解除，BR-FUND-19）；风控状态不变；别的差错单不动', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  const other = await seedCase(f);
  const hold = await seedHold(f, {
    user_id: c.userId,
    reason: 'recon_diff',
    source_ref: sourceOf(c.diff.id),
    created_by: 'system:test',
  });
  await withRestoreAdmin(f, async (h) => {
    const before = await everything(f);
    await restored(await h.restore(c.diff.id));
    const after = await everything(f);
    expect(after.orders).toEqual(before.orders);
    expect(after.holds).toEqual(before.holds);
    expect(after.risk).toEqual(before.risk);
    expect(await holdNow(f, hold)).toEqual(hold);
    expect(await diffNow(f, other.diff.id)).toEqual(other.diff);
    expect(await available(f, other.userId)).toBe(0n);
  });
});

it('[AC-B2-09g#20] RESTORE 计入净额：同一份额的两张差错单（两轮申诉）都处理时不补两次：第一张补 85，第二张重算差额 0、不写分录、差错单照样 adjusted；已有补发后余额只多 85', async () => {
  const f = await fixture(s);
  const order = await seedOrder(f);
  const userId = order.user('direct');
  const first = await seedRestoreDiff(f, order);
  const second = await seedRestoreDiff(f, order, { patch: { period: '2026-09' } });
  await withRestoreAdmin(f, async (h) => {
    expect((await restored(await h.restore(first.id))).restored_fen).toBe(85);
    expect((await restored(await h.restore(second.id))).restored_fen).toBe(0);
    await expectRestored(f, second, { adminId: h.operator.id, paid: { direct: 0n } });
    expect((await restoreVouchers(f)).map((v) => v.uniq_key)).toEqual([
      restoreKey(order.orderKey, userId, 'direct', first.id),
    ]);
    expect(await available(f, userId)).toBe(85n);
    expect(netOf(await netsOf(f, order.orderKey), userId, 'direct')).toBe(85n);
  });
});

it('[AC-B2-09g#21] 处理中（processing）的差错单也能处理，原处理人被操作人替换；超管也能处理；处理后 GET 详情与应答里的 recon_diff 一致；只有 fund.recon / fund.view 的账号能读不能处理（10403）', async () => {
  const f = await fixture(s);
  const order = await seedOrder(f);
  await withRestoreAdmin(f, async (h) => {
    const diff = await seedRestoreDiff(f, order, {
      patch: { status: 'processing', handler_id: h.viewer.id },
    });
    await answer(await h.restore(diff.id, {}, { caller: h.viewer }), 10403, {
      reason: 'admin_permission_denied',
    });
    const root = await h.caller([], { superAdmin: true });
    const data = await restored(await h.restore(diff.id, {}, { caller: root }));
    await expectRestored(f, diff, { adminId: root.id, paid: { direct: 85n } });
    const detail = await answer(await h.detail(diff.id), 0);
    expect(normalize(detail.data)).toEqual(data.recon_diff);
  });
});

it('[AC-B2-09g#22] 应用隔离与多差错单：同一应用另一张差错单不被顺带处理；另一应用同形差错单不动', async () => {
  const f = await fixture(s);
  const other = await fixture(s);
  const c = await seedCase(f);
  const sibling = await seedCase(f);
  await seedCase(other);
  const foreignBefore = await everything(other);
  await withRestoreAdmin(f, async (h) => {
    await restored(await h.restore(c.diff.id));
    expect(await diffNow(f, sibling.diff.id)).toEqual(sibling.diff);
    expect(await available(f, sibling.userId)).toBe(0n);
    expect(await everything(other)).toEqual(foreignBefore);
  });
});

it('[AC-B2-09g#23] 四种受益角色都按快照比例补发（self 5000 / share 5000 / direct 1000 / indirect 500，基数 850）：键上的角色与贷方账户一一对应', async () => {
  const f = await fixture(s);
  const rows: readonly (readonly [Role, number, bigint])[] = [
    ['self', 5000, 425n],
    ['share', 5000, 425n],
    ['direct', 1000, 85n],
    ['indirect', 500, 42n],
  ];
  const cases: { readonly c: Case; readonly role: Role; readonly fen: bigint }[] = [];
  for (const [role, ratioBp, fen] of rows) {
    const c = await seedCase(f, { people: [{ role, ratioBp, forfeited: true }] });
    cases.push({ c, role, fen });
  }
  await withRestoreAdmin(f, async (h) => {
    for (const { c, role, fen } of cases) {
      expect((await restored(await h.restore(c.diff.id))).restored_fen).toBe(Number(fen));
      const key = restoreKey(c.order.orderKey, c.userId, role, c.diff.id);
      expect(await voucherLines(f, key)).toEqual(restoreLines(c.userId, fen));
    }
  });
});

it('[AC-B2-09g#31] 已入账净额按 BR-FUND-08 的全部凭证类型算，不只 CREDIT 与 RESTORE：CREDIT 60 + CLAWBACK −20 → 净额 40、应得 85、补 45；CREDIT 60 + SETTLE_ADJUST +17 → 净额 77、基数 1020 应得 102、补 25；CREDIT 85 + SETTLE_ADJUST +17 → 净额 102、补 0 不写分录；CREDIT 60 + REASSIGN_REV −60 + REASSIGN_CREDIT +40 → 净额 40、补 45；五类都有 → 净额 30、补 72；余额与净额都只多实发额', async () => {
  const f = await fixture(s);
  const rows: readonly {
    readonly settleFen: bigint;
    readonly creditedFen: bigint;
    readonly steps: readonly NetStep[];
    readonly net: bigint;
    readonly paid: bigint;
  }[] = [
    {
      settleFen: 1000n,
      creditedFen: 60n,
      steps: [{ kind: 'CLAWBACK', fen: -20n }],
      net: 40n,
      paid: 45n,
    },
    {
      settleFen: 1200n,
      creditedFen: 60n,
      steps: [{ kind: 'SETTLE_ADJUST', fen: 17n }],
      net: 77n,
      paid: 25n,
    },
    {
      settleFen: 1200n,
      creditedFen: 85n,
      steps: [{ kind: 'SETTLE_ADJUST', fen: 17n }],
      net: 102n,
      paid: 0n,
    },
    {
      settleFen: 1000n,
      creditedFen: 60n,
      steps: [
        { kind: 'REASSIGN_REV', fen: -60n },
        { kind: 'REASSIGN_CREDIT', fen: 40n },
      ],
      net: 40n,
      paid: 45n,
    },
    {
      settleFen: 1200n,
      creditedFen: 60n,
      steps: [
        { kind: 'SETTLE_ADJUST', fen: 17n },
        { kind: 'CLAWBACK', fen: -20n },
        { kind: 'REASSIGN_REV', fen: -57n },
        { kind: 'REASSIGN_CREDIT', fen: 30n },
      ],
      net: 30n,
      paid: 72n,
    },
  ];
  const cases: { readonly c: Case; readonly net: bigint; readonly paid: bigint }[] = [];
  for (const { settleFen, creditedFen, steps, net, paid } of rows) {
    const c = await seedCase(f, {
      settleFen,
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, forfeited: true, creditedFen, steps },
      ],
    });
    cases.push({ c, net, paid });
  }
  await withRestoreAdmin(f, async (h) => {
    for (const { c, net, paid } of cases) {
      const { orderKey } = c.order;
      expect(netOf(await netsOf(f, orderKey), c.userId, 'direct')).toBe(net);
      expect(await available(f, c.userId)).toBe(net);

      expect((await restored(await h.restore(c.diff.id))).restored_fen).toBe(Number(paid));
      await expectRestored(f, c.diff, { adminId: h.operator.id, paid: { direct: paid } });
      expect(await voucherLines(f, restoreKey(orderKey, c.userId, 'direct', c.diff.id))).toEqual(
        paid > 0n ? restoreLines(c.userId, paid) : [],
      );
      expect(await available(f, c.userId)).toBe(net + paid);
      expect(netOf(await netsOf(f, orderKey), c.userId, 'direct')).toBe(net + paid);
    }
  });
});

it('[AC-B2-09g#32] BR-FUND-22：PUNISH（联盟处罚）作废的订单不在申诉恢复范围：入账时份额被没收，订单随后因 PUNISH 全额扣回（R8：booked_base_fen 0，settle_commission_fen 保留），封禁申诉撤销后差错单照常登记（expected_fen 85）→ 处理实发 0、无 RESTORE 凭证、分录与余额不变、订单不动；依 D10-469 ③ 差错单照样 adjusted，active 事件照追加，审计 restored_fen 为 0', async () => {
  const f = await fixture(s);
  const c = await seedCase(f, { punished: true });
  expect(c.diff.expected_fen).toBe(85n);
  const eventsBefore = await shareEvents(f, c.order.orderId);
  await withRestoreAdmin(f, async (h) => {
    const before = await everything(f);
    expect(before.orders).toHaveLength(1);
    expect(before.orders[0]).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      reason: 'PUNISH',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      settle_commission_fen: 1000n,
    });
    const nets = await netsOf(f, c.order.orderKey);
    expect(netOf(nets, c.userId, 'direct')).toBe(0n);
    expect(netOf(nets, c.order.user('self'), 'self')).toBe(0n);
    expect(nets.platform_net_fen).toBe(0n);
    expect(nets.union_receivable_net_fen).toBe(0n);

    expect((await restored(await h.restore(c.diff.id))).restored_fen).toBe(0);
    await expectRestored(f, c.diff, { adminId: h.operator.id, paid: { direct: 0n } });

    expect(await restoreVouchers(f)).toEqual([]);
    expect(await available(f, c.userId)).toBe(0n);
    const after = await everything(f);
    expect(after.orders).toEqual(before.orders);
    expect(after.entries).toEqual(before.entries);
    expect(after.balances).toEqual(before.balances);
    const added = (await shareEvents(f, c.order.orderId)).slice(eventsBefore.length);
    expect(added.map((e) => [e.user_id, e.role, e.status])).toEqual([
      [c.userId, 'direct', 'active'],
    ]);
    const records = await audits(f, RESTORE_ACTION);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0]!.after)).toMatch(/"restored_fen":"?0"?[,}]/);
  });
});
