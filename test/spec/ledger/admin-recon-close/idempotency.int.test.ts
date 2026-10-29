// B2-09b idempotency rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// closeAdminReconDiff (`Idempotency-Key` is required: same key and body → the first result, the
// same released_hold_count; same key with another body → 20901; same key while still running →
// 40901; a new key for a difference that is already closed → 20902); 规划/04 §5「幂等」 (admin
// subject a:<admin_users.id>: another account's key is its own scope). A replay runs nothing: a hold
// added after the first close stays in effect. Requests go through the real admin entry (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CLOSE_ACTION,
  RECON,
  allHolds,
  answer,
  audits,
  closePath,
  closed,
  conflict,
  diffNow,
  expectClosed,
  fixture,
  holdRow,
  idempotencyRows,
  member,
  newKey,
  releasedBy,
  seedDiff,
  seedHold,
  sourceOf,
  suite,
  track,
  waiting,
  withCloseAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09b#9] 同一 Idempotency-Key 同一请求体重放：原样返回第一次的应答（同一 released_hold_count），不再解除、不再写审计（第一次之后新加的同源冻结仍生效）；同 key 换请求体 → 20901；新 key → 20902；别的账号用同一 key 是它自己的作用域 → 20902', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await seedDiff(f, {
      source: 'R2',
      type: 'channel_mismatch',
      ref_type: 'withdrawal',
    });
    const first = await seedHold(f, { user_id: await member(f), source_ref: sourceOf(diff.id) });
    const key = newKey();
    const body = { reason: '通道已退回，核对一致' };
    const sent = await h.close(diff.id, body, { key });
    expect((await closed(sent)).released_hold_count).toBe(1);
    const after = await expectClosed(f, diff, h.recon.id, body.reason);
    const recorded = await audits(f);

    const late = await seedHold(f, { user_id: await member(f), source_ref: sourceOf(diff.id) });
    for (let i = 0; i < 2; i += 1) {
      const again = await h.close(diff.id, body, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }
    await answer(await h.close(diff.id, { reason: '换一个原因' }, { key }), 20901);
    await conflict(await h.close(diff.id, body));
    const colleague = await h.caller([RECON]);
    await conflict(await h.close(diff.id, body, { key, caller: colleague }));

    expect(await diffNow(f, diff.id)).toEqual(after);
    const holds = await allHolds(f);
    expect(holds).toContainEqual(releasedBy(f, first, h.recon.id));
    expect(holds).toContainEqual(late);
    expect(await audits(f)).toEqual(recorded);
  });
});

it('[AC-B2-09b#10] Idempotency-Key 必填：不带或格式不对 → 20001，差错单与冻结不动、不留幂等记录；同一 key 的第一次还在执行时再发（同体或换体）→ 40901，放行后第一次照常完成，之后重放得到它的应答', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await seedDiff(f, {
      source: 'R3',
      type: 'ledger_mismatch',
      ref_type: 'account',
    });
    const hold = await seedHold(f, {
      user_id: await member(f),
      reason: 'ledger_mismatch',
      source_ref: sourceOf(diff.id),
    });
    await answer(await h.close(diff.id, { reason: '核对' }, { key: null }), 20001);
    await answer(await h.close(diff.id, { reason: '核对' }, { key: 'short' }), 20001);
    await answer(await h.close(diff.id, { reason: '核对' }, { key: 'bad key with spaces' }), 20001);
    expect(await diffNow(f, diff.id)).toEqual(diff);
    expect(await allHolds(f)).toEqual([hold]);
    expect(await idempotencyRows(f)).toEqual([]);
    expect(await audits(f)).toEqual([]);

    const key = newKey();
    const body = { reason: '日终差异已人工核对' };
    const lock = await holdRow(f, 'recon_diffs', diff.id);
    const first = track(h.close(diff.id, body, { key }));
    try {
      expect(await waiting(f, 1, [first]), '第一次请求应在差错单行锁上等待').toBe(true);
      await answer(await h.close(diff.id, body, { key }), 40901);
      await answer(await h.close(diff.id, { reason: '另一个原因' }, { key }), 40901);
      expect(await diffNow(f, diff.id)).toEqual(diff);
    } finally {
      await lock.release();
    }
    const sent = await first.promise;
    expect((await closed(sent)).released_hold_count).toBe(1);
    await expectClosed(f, diff, h.recon.id, body.reason);
    expect(await allHolds(f)).toEqual([releasedBy(f, hold, h.recon.id)]);
    const replay = await h.close(diff.id, body, { key });
    expect(replay.body).toBe(sent.body);
    expect(await audits(f, CLOSE_ACTION)).toHaveLength(1);
    const rows = (await idempotencyRows(f)).filter((row) => row.key === key);
    expect(rows.map((row) => ({ path: row.path, status: row.status }))).toEqual([
      { path: closePath(diff.id), status: 'completed' },
    ]);
  });
});
