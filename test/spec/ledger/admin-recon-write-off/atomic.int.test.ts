// B2-07e write-off rule tests, idempotency, atomicity and locks (claude-independent, SPEC_REF
// 37808a50): contracts/openapi.yaml writeOffAdminReconDiff (`Idempotency-Key` required: same key
// and body → the first result; another body → 20901; still running → 40901; the subject is the
// admin account); everything in one transaction — a failure anywhere (the hold release, the
// difference's update, the audit record) leaves the withdrawal APPROVED, no voucher, no job
// (D10-428: the attempt-append job commits with the write-off or not at all), no event, the
// difference and holds as they were and no idempotency record; BR-WDR-07 lock order (the users
// row is locked: a write-off waits for it); two write-offs of one difference at once → exactly one
// settles, the other 20902 resource=recon_diff; one voucher. Requests go through the real admin
// entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  BODY,
  EXECUTE,
  FAULT_POINTS,
  WRITE_OFF_ACTION,
  answer,
  attemptJobs,
  audits,
  changes,
  diffConflict,
  everything,
  fixture,
  holdNow,
  holdRow,
  idempotencyRows,
  newKey,
  seedCase,
  seedHold,
  sourceOf,
  suite,
  track,
  waiting,
  withWriteOffAdmin,
  withdrawalRow,
  withdrawalVouchers,
  writeOffPath,
  writtenOff,
} from './kit.ts';

const s = suite();

it('[AC-B2-07e#32] 同一 Idempotency-Key 同一请求体重放：原样返回第一次的应答，不再记账、不再入队、不再发事件、不再写审计、不再解冻（第一次之后新加的同源冻结仍生效）；同 key 换请求体 → 20901；新 key → 20902 recon_diff；别的账号用同一 key 是它自己的作用域 → 20902 recon_diff', async () => {
  const f = fixture(s);
  const c = await seedCase(f);
  await withWriteOffAdmin(f, async (h) => {
    const key = newKey();
    const body = { ...BODY, note: '按账单行核销' };
    const sent = await h.writeOff(c.diff.id, body, { key });
    expect((await writtenOff(sent)).released_hold_count).toBe(1);
    const after = await everything(f);
    const late = await seedHold(f, {
      user_id: c.userId,
      reason: 'recon_diff',
      source_ref: sourceOf(c.diff.id),
      created_by: 'system:payout-recon',
    });

    for (let i = 0; i < 2; i += 1) {
      const again = await h.writeOff(c.diff.id, body, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }
    await answer(await h.writeOff(c.diff.id, { ...BODY, note: '换一个说明' }, { key }), 20901);
    await diffConflict(await h.writeOff(c.diff.id, body));
    const colleague = await h.caller([EXECUTE]);
    await diffConflict(await h.writeOff(c.diff.id, body, { key, caller: colleague }));

    expect(await holdNow(f, late)).toEqual(late);
    const now = await everything(f);
    expect({ ...now, holds: now.holds.filter((hold) => hold.id !== late.id) }).toEqual(after);
    expect(
      (await withdrawalVouchers(f.db, f.appId)).filter((k) => k === `wd:${c.w.id}:PAID`),
    ).toHaveLength(1);
    expect(await attemptJobs(f, c.w.id)).toHaveLength(1);
    expect(await changes(f.db, f.appId)).toHaveLength(1);
    expect(await audits(f, WRITE_OFF_ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-07e#33] Idempotency-Key 必填：不带或格式不对 → 20001，什么都不变、不留幂等记录；同一 key 的第一次还在执行时再发（同体或换体）→ 40901，放行后第一次照常完成，之后重放得到它的应答', async () => {
  const f = fixture(s);
  const c = await seedCase(f);
  await withWriteOffAdmin(f, async (h) => {
    const before = await everything(f);
    await answer(await h.writeOff(c.diff.id, BODY, { key: null }), 20001);
    await answer(await h.writeOff(c.diff.id, BODY, { key: 'short' }), 20001);
    await answer(await h.writeOff(c.diff.id, BODY, { key: 'bad key with spaces' }), 20001);
    expect(await everything(f)).toEqual(before);
    expect(await idempotencyRows(f)).toEqual([]);

    const key = newKey();
    const lock = await holdRow(f, 'recon_diffs', c.diff.id);
    const first = track(h.writeOff(c.diff.id, BODY, { key }));
    try {
      expect(await waiting(f, 1, [first]), '第一次请求应在差错单行锁上等待').toBe(true);
      await answer(await h.writeOff(c.diff.id, BODY, { key }), 40901);
      await answer(await h.writeOff(c.diff.id, { ...BODY, note: '另一个说明' }, { key }), 40901);
      expect(await withdrawalRow(f.db, f.appId, c.w.id)).toMatchObject({ status: 'APPROVED' });
    } finally {
      await lock.release();
    }
    const sent = await first.promise;
    expect((await writtenOff(sent)).released_hold_count).toBe(1);
    const replay = await h.writeOff(c.diff.id, BODY, { key });
    expect(replay.body).toBe(sent.body);
    expect(await audits(f, WRITE_OFF_ACTION)).toHaveLength(1);
    const rows = (await idempotencyRows(f)).filter((row) => row.key === key);
    expect(rows.map((row) => ({ path: row.path, status: row.status }))).toEqual([
      { path: writeOffPath(c.diff.id), status: 'completed' },
    ]);
  });
});

it('[AC-B2-07e#34] 一个事务：解冻、改差错单、写审计任一步失败 → 50001，整笔回滚——提现单仍 APPROVED、没有 wd:{id}:PAID、没有 attempt-append 任务（入队与核销原子提交，D10-428）、没有事件、差错单与冻结不变、不留幂等记录；同一 key 重发即成功', async () => {
  const f = fixture(s);
  await withWriteOffAdmin(f, async (h) => {
    for (const point of FAULT_POINTS) {
      const c = await seedCase(f);
      const before = await everything(f);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.writeOff(c.diff.id, BODY, { key });
      expect(h.fault.tripped, `${point} 必须在核销事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await everything(f), point).toEqual(before);
      expect(await attemptJobs(f, c.w.id), point).toEqual([]);
      expect(
        (await idempotencyRows(f)).filter((row) => row.key === key),
        point,
      ).toEqual([]);

      await writtenOff(await h.writeOff(c.diff.id, BODY, { key }));
      expect(await attemptJobs(f, c.w.id), point).toHaveLength(1);
    }
  });
});

it('[AC-B2-07e#35] 锁序 BR-WDR-07：会员 users 行被别的事务锁着时核销等待，期间提现单与差错单都不变；放行后完成。同一差错单两个核销同时到（不同 key）→ 恰一个成功，另一个 20902 recon_diff；凭证、任务、事件、审计各一', async () => {
  const f = fixture(s);
  const c = await seedCase(f);
  const twin = await seedCase(f);
  await withWriteOffAdmin(f, async (h) => {
    const lock = await holdRow(f, 'users', c.userId);
    const pending = track(h.writeOff(c.diff.id, BODY));
    try {
      expect(await waiting(f, 1, [pending]), '核销应在 users 行锁上等待').toBe(true);
      expect(await withdrawalRow(f.db, f.appId, c.w.id)).toMatchObject({ status: 'APPROVED' });
    } finally {
      await lock.release();
    }
    await writtenOff(await pending.promise);

    const results = await Promise.all([
      h.writeOff(twin.diff.id, BODY),
      h.writeOff(twin.diff.id, BODY),
    ]);
    const codes = results.map((sent) => sent.json().code).sort((a, b) => a - b);
    expect(codes).toEqual([0, 20902]);
    for (const sent of results) {
      if (sent.json().code === 0) await writtenOff(sent);
      else await diffConflict(sent);
    }
    expect(
      (await withdrawalVouchers(f.db, f.appId)).filter((k) => k === `wd:${twin.w.id}:PAID`),
    ).toHaveLength(1);
    expect(await attemptJobs(f, twin.w.id)).toHaveLength(1);
    expect(
      (await changes(f.db, f.appId)).filter((data) => data['withdrawal_id'] === twin.w.id),
    ).toHaveLength(1);
    expect(await audits(f, WRITE_OFF_ACTION)).toHaveLength(2);
  });
});
