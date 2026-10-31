// B2-09g restore rule tests, idempotency, atomicity and locks (claude-independent, SPEC_REF
// 81273415): contracts/openapi.yaml restoreAdminReconDiff (`Idempotency-Key` required: same key and
// body → the first result; another body → 20901; still running → 40901; a new key for an adjusted
// difference → 20902; the subject is the admin account); everything in one transaction — a failure
// anywhere (the share event, the voucher, the difference's update, the audit record) leaves no
// voucher, no event, the balance and the difference as they were and no idempotency record; settlement
// AGENTS.md 硬规则 3 and 12 §4.8: the order key's lock, then the users row (a restore waits for
// them, reads the net inside the order key's lock and the member's status after the users row's
// lock); two restores at once pay exactly once. Requests go through the real admin entry (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  FAULT_POINTS,
  RESTORE,
  RESTORE_ACTION,
  answer,
  audits,
  available,
  conflict,
  diffNow,
  everything,
  fixture,
  holdOrderKey,
  holdRow,
  holdUserIntoDeleting,
  idempotencyRows,
  memberOf,
  newKey,
  refused,
  restoreKey,
  restorePath,
  restoreVouchers,
  restored,
  seedCase,
  seedOrder,
  seedRestoreDiff,
  shareEvents,
  suite,
  track,
  waiting,
  withRestoreAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09g#24] 同一 Idempotency-Key 同一请求体重放：原样返回第一次的应答（同一 restored_fen），不再记账、不再加事件、不再写审计；同 key 换请求体 → 20901；新 key → 20902 recon_diff；别的账号用同一 key 是它自己的作用域 → 20902 recon_diff', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  await withRestoreAdmin(f, async (h) => {
    const key = newKey();
    const body = { note: '核对后补发' };
    const sent = await h.restore(c.diff.id, body, { key });
    expect((await restored(sent)).restored_fen).toBe(85);
    const after = await everything(f);

    for (let i = 0; i < 2; i += 1) {
      const again = await h.restore(c.diff.id, body, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }
    await answer(await h.restore(c.diff.id, { note: '换一个说明' }, { key }), 20901);
    await conflict(await h.restore(c.diff.id, body));
    const colleague = await h.caller([RESTORE]);
    await conflict(await h.restore(c.diff.id, body, { key, caller: colleague }));

    expect(await everything(f)).toEqual(after);
    expect((await restoreVouchers(f)).map((v) => v.uniq_key)).toEqual([
      restoreKey(c.order.orderKey, c.userId, 'direct', c.diff.id),
    ]);
    expect(await audits(f, RESTORE_ACTION)).toHaveLength(1);
    expect(await available(f, c.userId)).toBe(85n);
  });
});

it('[AC-B2-09g#25] Idempotency-Key 必填：不带或格式不对 → 20001，什么都不变、不留幂等记录；同一 key 的第一次还在执行时再发（同体或换体）→ 40901，放行后第一次照常完成，之后重放得到它的应答', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  await withRestoreAdmin(f, async (h) => {
    const before = await everything(f);
    await answer(await h.restore(c.diff.id, {}, { key: null }), 20001);
    await answer(await h.restore(c.diff.id, {}, { key: 'short' }), 20001);
    await answer(await h.restore(c.diff.id, {}, { key: 'bad key with spaces' }), 20001);
    expect(await everything(f)).toEqual(before);
    expect(await idempotencyRows(f)).toEqual([]);

    const key = newKey();
    const lock = await holdRow(f, 'recon_diffs', c.diff.id);
    const first = track(h.restore(c.diff.id, {}, { key }));
    try {
      expect(await waiting(f, 1, [first]), '第一次请求应在差错单行锁上等待').toBe(true);
      await answer(await h.restore(c.diff.id, {}, { key }), 40901);
      await answer(await h.restore(c.diff.id, { note: '另一个说明' }, { key }), 40901);
      expect(await restoreVouchers(f)).toEqual([]);
    } finally {
      await lock.release();
    }
    const sent = await first.promise;
    expect((await restored(sent)).restored_fen).toBe(85);
    const replay = await h.restore(c.diff.id, {}, { key });
    expect(replay.body).toBe(sent.body);
    expect(await audits(f, RESTORE_ACTION)).toHaveLength(1);
    const rows = (await idempotencyRows(f)).filter((row) => row.key === key);
    expect(rows.map((row) => ({ path: row.path, status: row.status }))).toEqual([
      { path: restorePath(c.diff.id), status: 'completed' },
    ]);
  });
});

it('[AC-B2-09g#26] 一个事务：追加事件、写凭证、改差错单、写审计任一步失败 → 50001，整笔回滚——两个角色都没有 RESTORE 凭证、没有新事件、余额与差错单不变、不留幂等记录；同一 key 重发即成功且只入账一次', async () => {
  const f = await fixture(s);
  await withRestoreAdmin(f, async (h) => {
    for (const point of FAULT_POINTS) {
      const userId = await memberOf(f);
      const c = await seedCase(f, {
        people: [
          { role: 'share', ratioBp: 5000, userId, forfeited: true },
          { role: 'direct', ratioBp: 1000, userId, forfeited: true },
        ],
      });
      const before = await everything(f);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.restore(c.diff.id, {}, { key });
      expect(h.fault.tripped, `${point} 必须在处理事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await everything(f), point).toEqual(before);
      expect(
        (await idempotencyRows(f)).filter((row) => row.key === key),
        point,
      ).toEqual([]);

      const data = await restored(await h.restore(c.diff.id, {}, { key }));
      expect(data.restored_fen, point).toBe(510);
      expect(await available(f, userId), point).toBe(510n);
    }
  });
});

it('[AC-B2-09g#27] 锁序：订单键 advisory 锁被别的事务持有时处理等待，期间差错单、账务不变；放行后完成', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  await withRestoreAdmin(f, async (h) => {
    const lock = await holdOrderKey(f, c.order.orderKey);
    const pending = track(h.restore(c.diff.id));
    try {
      expect(await waiting(f, 1, [pending]), '处理应在订单键锁上等待').toBe(true);
      expect(await diffNow(f, c.diff.id)).toEqual(c.diff);
      expect(await restoreVouchers(f)).toEqual([]);
    } finally {
      await lock.release();
    }
    expect((await restored(await pending.promise)).restored_fen).toBe(85);
  });
});

it('[AC-B2-09g#28] 锁序：会员 users 行被别的事务锁着时处理等待（BR-FUND-16 加锁流程），期间差错单、账务不变；放行后完成', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  await withRestoreAdmin(f, async (h) => {
    const lock = await holdRow(f, 'users', c.userId);
    const pending = track(h.restore(c.diff.id));
    try {
      expect(await waiting(f, 1, [pending]), '处理应在 users 行锁上等待').toBe(true);
      expect(await diffNow(f, c.diff.id)).toEqual(c.diff);
      expect(await restoreVouchers(f)).toEqual([]);
      expect(await available(f, c.userId)).toBe(0n);
    } finally {
      await lock.release();
    }
    expect((await restored(await pending.promise)).restored_fen).toBe(85);
  });
});

it('[AC-B2-09g#29] 并发：同一差错单两个处理同时到（不同 key）→ 恰一个成功，另一个 20902 recon_diff；凭证、active 事件、审计各一，余额只多一次', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  const before = await shareEvents(f, c.order.orderId);
  await withRestoreAdmin(f, async (h) => {
    const results = await Promise.all([h.restore(c.diff.id), h.restore(c.diff.id)]);
    expect(results.map((sent) => sent.statusCode).sort((a, b) => a - b)).toEqual([200, 409]);
    for (const sent of results) {
      if (sent.statusCode === 200) expect((await restored(sent)).restored_fen).toBe(85);
      else await conflict(sent);
    }
    expect((await restoreVouchers(f)).map((v) => v.uniq_key)).toEqual([
      restoreKey(c.order.orderKey, c.userId, 'direct', c.diff.id),
    ]);
    expect((await shareEvents(f, c.order.orderId)).slice(before.length)).toHaveLength(1);
    expect(await audits(f, RESTORE_ACTION)).toHaveLength(1);
    expect(await available(f, c.userId)).toBe(85n);
  });
});

it('[AC-B2-09g#30] 并发：同一份额的两张差错单：订单键锁被占时两个处理都在等，放行后都成功，合计只补一次 85（净额在订单键锁内读，键不同也不重复补）', async () => {
  const f = await fixture(s);
  const order = await seedOrder(f);
  const userId = order.user('direct');
  const first = await seedRestoreDiff(f, order);
  const second = await seedRestoreDiff(f, order, { patch: { period: '2026-09' } });
  await withRestoreAdmin(f, async (h) => {
    const lock = await holdOrderKey(f, order.orderKey);
    const pending = [track(h.restore(first.id)), track(h.restore(second.id))];
    try {
      expect(await waiting(f, 2, pending), '两个处理都应在订单键锁上等待').toBe(true);
      expect(await restoreVouchers(f)).toEqual([]);
    } finally {
      await lock.release();
    }
    const results = await Promise.all(pending.map((request) => request.promise));
    const paid: number[] = [];
    for (const sent of results) paid.push(Number((await restored(sent)).restored_fen));
    expect(paid.sort((a, b) => a - b)).toEqual([0, 85]);
    expect(await restoreVouchers(f)).toHaveLength(1);
    expect(await available(f, userId)).toBe(85n);
  });
});

it('[AC-B2-09g#33] 依 D10-469 ① 与 12 §4.8：处理在 users 行锁上等待时，持锁事务把会员改成 deleting 并提交（deletion-expiry）→ 处理按锁内状态拒绝 20001 data.fields=[recon_diff_id] reason=restore_user_deleted：不写分录、不追加事件、余额与差错单不变、不存为幂等结果（会员状态在 users 行锁之后读）', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  await withRestoreAdmin(f, async (h) => {
    const before = await everything(f);
    const key = newKey();
    const lock = await holdUserIntoDeleting(f, c.userId);
    const pending = track(h.restore(c.diff.id, {}, { key }));
    try {
      expect(await waiting(f, 1, [pending]), '处理应在 users 行锁上等待').toBe(true);
      expect(await restoreVouchers(f)).toEqual([]);
    } finally {
      await lock.release();
    }
    await refused(await pending.promise, 'restore_user_deleted');
    expect(await everything(f)).toEqual(before);
    expect((await idempotencyRows(f)).filter((row) => row.key === key)).toEqual([]);
  });
});
