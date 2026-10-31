// B2-09h concurrency and roll-back rule tests (claude-independent, SPEC_REF 9ab94dc0):
// contracts/openapi.yaml closeAdminReconDiff (effects in one transaction; the conclusion cannot be
// changed; a difference already closed → 20902), with the row lock and the status compare-and-set
// of the close (../admin-recon-close/concurrency.int.test.ts). The conclusion takes effect with the
// close's commit: the monthly check reads it on its own connection. Requests go through the real
// admin entry (kit.ts); the one-shot fault sits in the entry's database handle. Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CLOSE_ACTION,
  FAULT_POINTS,
  OUTCOMES,
  RECON,
  allHolds,
  answer,
  audits,
  auditText,
  closed,
  conflict,
  diffNow,
  expectConcluded,
  fixture,
  holdRow,
  member,
  newKey,
  r1Diff,
  releasedBy,
  seedHold,
  sourceOf,
  suite,
  track,
  unionKeys,
  waiting,
  withCloseAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09h#14] 两个账号同时用不同 outcome 关同一张 R1 单：恰好一个 0、另一个 20902；resolution.outcome、handler_id 与唯一一条审计都是成功的那一个', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await r1Diff(f);
    const callers = [h.recon, await h.caller([RECON])];
    const reason = '两人同时结案';
    const lock = await holdRow(f, 'recon_diffs', diff.id);
    const requests = callers.map((caller, i) =>
      track(h.close(diff.id, { reason, outcome: OUTCOMES[i] }, { caller, key: newKey() })),
    );
    try {
      expect(await waiting(f, 2, requests), '两个请求都应在差错单行锁上等待').toBe(true);
    } finally {
      await lock.release();
    }
    const sent = await Promise.all(requests.map((request) => request.promise));
    const codes = sent.map((one) => one.json().code);
    expect(
      [...codes].sort((a, b) => a - b),
      JSON.stringify(sent.map((one) => one.body)),
    ).toEqual([0, 20902]);
    const winner = codes.indexOf(0);
    await closed(sent[winner]!);
    await conflict(sent[1 - winner]!);
    const outcome = OUTCOMES[winner]!;
    await expectConcluded(f, diff, callers[winner]!.id, { reason, outcome });
    const records = await audits(f, CLOSE_ACTION);
    expect(records).toHaveLength(1);
    expect(auditText(records[0]!)).toContain(`"outcome":"${outcome}"`);
  });
});

it('[AC-B2-09h#15] 结论随结案事务提交才生效：关闭停在解除冻结的 users 行锁上时，别的连接读差错单仍是原样、读口不算；放行提交后读口才返回该单', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await r1Diff(f);
    const userId = await member(f);
    await seedHold(f, { user_id: userId, source_ref: sourceOf(diff.id) });
    const lock = await holdRow(f, 'users', userId);
    const request = track(h.close(diff.id, { reason: '以联盟为准', outcome: 'union' }));
    try {
      expect(await waiting(f, 1, [request]), '关闭应在 users 行锁上等待').toBe(true);
      expect(await diffNow(f, diff.id)).toEqual(diff);
      expect(await unionKeys(f.db, f.appId, [diff.ref_id])).toEqual([]);
    } finally {
      await lock.release();
    }
    await closed(await request.promise);
    expect(await unionKeys(f.db, f.appId, [diff.ref_id])).toEqual([diff.ref_id]);
  });
});

it('[AC-B2-09h#16] 任一步失败整笔回滚：解除冻结的 UPDATE、差错单的 UPDATE、两种审计任一处失败 → 50001，差错单仍是原样、读口不算；同一 Idempotency-Key 重试才写入 outcome', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    for (const [i, point] of FAULT_POINTS.entries()) {
      const diff = await r1Diff(f);
      const hold = await seedHold(f, {
        user_id: await member(f),
        source_ref: sourceOf(diff.id),
      });
      const key = newKey();
      const body = { reason: `第 ${i + 1} 次`, outcome: 'union' };
      h.fault.point = point;
      const failed = await h.close(diff.id, body, { key });
      expect(h.fault.tripped, point).toBe(i + 1);
      await answer(failed, 50001);
      expect(await diffNow(f, diff.id), point).toEqual(diff);
      expect(await unionKeys(f.db, f.appId, [diff.ref_id]), point).toEqual([]);

      await closed(await h.close(diff.id, body, { key }));
      await expectConcluded(f, diff, h.recon.id, body);
      expect(await allHolds(f), point).toContainEqual(releasedBy(f, hold, h.recon.id));
      expect(await unionKeys(f.db, f.appId, [diff.ref_id]), point).toEqual([diff.ref_id]);
    }
  });
});
