// B2-09b concurrency and roll-back rule tests (claude-independent, SPEC_REF 37808a50):
// contracts/openapi.yaml closeAdminReconDiff (effects in one transaction; a difference already
// closed → 20902); task brief (recon_diffs row lock and status compare-and-set: of two closes at
// once exactly one succeeds; the holds are released through payout, which locks the users rows
// first in user_id order, BR-WDR-05 / BR-WDR-07, so closes of two differences sharing members
// neither deadlock nor lose a release; any failing step rolls the whole close back). Requests go
// through the real admin entry (kit.ts); the one-shot fault sits in the entry's database handle.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CLOSE_ACTION,
  FAULT_POINTS,
  RECON,
  RELEASE_ACTION,
  allHolds,
  answer,
  audits,
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
  type HoldRow,
} from './kit.ts';

const s = suite();

function byId(rows: readonly HoldRow[]): HoldRow[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

it('[AC-B2-09b#11] 两个账号同时关同一张差错单（各用自己的 Idempotency-Key）：恰好一个 0、另一个 20902 data.resource=recon_diff；handler_id 与每条冻结的 released_by 都是成功的那个账号，冻结只解除一次，只有一条 recon_diff_close 审计', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await seedDiff(f, {
      source: 'R2',
      type: 'channel_mismatch',
      ref_type: 'withdrawal',
    });
    const holds = [
      await seedHold(f, { user_id: await member(f), source_ref: sourceOf(diff.id) }),
      await seedHold(f, { user_id: await member(f), source_ref: sourceOf(diff.id) }),
    ];
    const callers = [h.recon, await h.caller([RECON])];
    const lock = await holdRow(f, 'recon_diffs', diff.id);
    const requests = callers.map((caller) =>
      track(h.close(diff.id, { reason: '两人同时结案' }, { caller, key: newKey() })),
    );
    try {
      expect(await waiting(f, 2, requests), '两个请求都应在差错单行锁上等待').toBe(true);
    } finally {
      await lock.release();
    }
    const sent = await Promise.all(requests.map((request) => request.promise));
    const codes = sent.map((one) => one.json().code);
    const bodies = JSON.stringify(sent.map((one) => one.body));
    expect(
      [...codes].sort((a, b) => a - b),
      bodies,
    ).toEqual([0, 20902]);
    const winner = codes.indexOf(0);
    const loser = 1 - winner;
    expect((await closed(sent[winner]!)).released_hold_count).toBe(2);
    await conflict(sent[loser]!);
    const by = callers[winner]!.id;
    await expectClosed(f, diff, by, '两人同时结案');
    expect(byId(await allHolds(f))).toEqual(byId(holds.map((hold) => releasedBy(f, hold, by))));
    expect(await audits(f, CLOSE_ACTION)).toHaveLength(1);
    expect(await audits(f, RELEASE_ACTION)).toHaveLength(2);
  });
});

it('[AC-B2-09b#12] 解除前先锁 users 行（BR-WDR-07 锁序，按 user_id 排序）：两张差错单冻结了同一批用户，users 行被占时两次关闭都等待、库里看不到半截结果；放行后两次都成功（不死锁），各自只解除自己来源的冻结', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const first = await member(f);
    const second = await member(f);
    const [low] = [first, second].sort();
    const diffs = [
      await seedDiff(f, { source: 'R2', type: 'channel_mismatch', ref_type: 'withdrawal' }),
      await seedDiff(f, { source: 'R3', type: 'ledger_mismatch', ref_type: 'account' }),
    ];
    // Each difference holds both members, seeded in opposite orders.
    const holds = [
      [
        await seedHold(f, { user_id: second, source_ref: sourceOf(diffs[0]!.id) }),
        await seedHold(f, { user_id: first, source_ref: sourceOf(diffs[0]!.id) }),
      ],
      [
        await seedHold(f, {
          user_id: first,
          reason: 'ledger_mismatch',
          source_ref: sourceOf(diffs[1]!.id),
        }),
        await seedHold(f, {
          user_id: second,
          reason: 'ledger_mismatch',
          source_ref: sourceOf(diffs[1]!.id),
        }),
      ],
    ];
    const callers = [h.recon, await h.caller([RECON])];
    const lock = await holdRow(f, 'users', low!);
    const requests = diffs.map((diff, i) =>
      track(h.close(diff.id, { reason: '同批用户' }, { caller: callers[i]! })),
    );
    try {
      expect(await waiting(f, 2, requests), '两次关闭都应在 users 行锁上等待').toBe(true);
      for (const diff of diffs) expect(await diffNow(f, diff.id)).toEqual(diff);
      expect(byId(await allHolds(f))).toEqual(byId(holds.flat()));
    } finally {
      await lock.release();
    }
    const sent = await Promise.all(requests.map((request) => request.promise));
    for (const [i, one] of sent.entries()) {
      expect((await closed(one)).released_hold_count).toBe(2);
      await expectClosed(f, diffs[i]!, callers[i]!.id, '同批用户');
    }
    expect(byId(await allHolds(f))).toEqual(
      byId(holds.flatMap((group, i) => group.map((hold) => releasedBy(f, hold, callers[i]!.id)))),
    );
  });
});

it('[AC-B2-09b#13] 任一步失败整笔回滚：解除冻结的 UPDATE、差错单的 UPDATE、withdraw_hold.release 审计、recon_diff_close 审计任一处失败 → 50001，差错单仍是原样、冻结都未解除、没有审计、不留幂等记录；同一 Idempotency-Key 重试照常关闭', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    for (const [i, point] of FAULT_POINTS.entries()) {
      const diff = await seedDiff(f, {
        source: 'R3',
        type: 'ledger_mismatch',
        ref_type: 'account',
      });
      const holds = [
        await seedHold(f, {
          user_id: await member(f),
          reason: 'ledger_mismatch',
          source_ref: sourceOf(diff.id),
        }),
        await seedHold(f, {
          user_id: await member(f),
          reason: 'ledger_mismatch',
          source_ref: sourceOf(diff.id),
        }),
      ];
      const before = await allHolds(f);
      const recorded = await audits(f);
      const key = newKey();
      h.fault.point = point;
      const failed = await h.close(diff.id, { reason: `第 ${i + 1} 次` }, { key });
      expect(h.fault.tripped, point).toBe(i + 1);
      await answer(failed, 50001);
      expect(await diffNow(f, diff.id), point).toEqual(diff);
      expect(await allHolds(f), point).toEqual(before);
      expect(await audits(f), point).toEqual(recorded);
      expect(
        (await idempotencyRows(f)).filter((row) => row.key === key),
        point,
      ).toEqual([]);

      const data = await closed(await h.close(diff.id, { reason: `第 ${i + 1} 次` }, { key }));
      expect(data.released_hold_count, point).toBe(2);
      await expectClosed(f, diff, h.recon.id, `第 ${i + 1} 次`);
      const now = await allHolds(f);
      for (const hold of holds) expect(now, point).toContainEqual(releasedBy(f, hold, h.recon.id));
    }
  });
});
