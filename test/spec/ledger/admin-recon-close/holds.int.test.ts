// B2-09b hold release rule tests (claude-independent, SPEC_REF 37808a50): 08 BR-FUND-19 (冻结方式：
// 为每个涉及用户新增 1 条 withdraw_holds 记录，source_ref=差错单；差错单关闭时解除该条记录（写
// released_at、released_by），同一用户的其他冻结记录不受影响), BR-WDR-05 (多个原因可以叠加，逐条解除；
// 新增和解除都记审计); contracts/openapi.yaml closeAdminReconDiff (every hold whose source is the
// difference and that is not released yet is released in the same transaction;
// released_hold_count counts this call's releases only; audit recon_diff_close with the reason and,
// before and after, status and released_hold_count, no personal data). The source of a diff's hold
// is source_ref = `recon_diff:<recon_diffs.id>`, matched exactly (task brief, 编排核定 2026-10-29);
// each released hold gets its own withdraw_hold.release audit record with the operator as actor.
// Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CLOSE_ACTION,
  RELEASE_ACTION,
  ago,
  allHolds,
  audits,
  closed,
  diffNow,
  expectClosed,
  fixture,
  member,
  releasedBy,
  seedDiff,
  seedHold,
  sourceOf,
  suite,
  withCloseAdmin,
  type HoldRow,
} from './kit.ts';

const s = suite();

function byId(rows: readonly HoldRow[]): HoldRow[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

it('[AC-B2-09b#7] 关闭时解除来源为该单（source_ref = recon_diff:<id>）的全部未解除冻结：写 released_at（服务端时钟）与 released_by（操作人），不论 reason、不论 hold_until 是否已过；已解除的、人工冻结、别的差错单的、source_ref 只写裸 id 或大小写不同的、其他应用的都不动；released_hold_count 只计本次解除的条数', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await seedDiff(f, {
      source: 'R2',
      type: 'channel_mismatch',
      ref_type: 'withdrawal',
    });
    const sibling = await seedDiff(f, { source: 'R2', type: 'channel_mismatch' });
    const users: string[] = [];
    for (let i = 0; i < 6; i += 1) users.push(await member(f));
    const [u1, u2, u3, u4, u5, u6] = users as [string, string, string, string, string, string];
    const ref = sourceOf(diff.id);
    const mine = [
      await seedHold(f, { user_id: u1, reason: 'recon_diff', source_ref: ref }),
      await seedHold(f, {
        user_id: u2,
        reason: 'recon_diff',
        source_ref: ref,
        hold_until: ago(f, 10),
      }),
      await seedHold(f, { user_id: u6, reason: 'ledger_mismatch', source_ref: ref }),
    ];
    const untouched = [
      await seedHold(f, {
        user_id: u3,
        source_ref: ref,
        released_at: ago(f, 30),
        released_by: h.viewer.id,
      }),
      await seedHold(f, {
        user_id: u1,
        reason: 'manual',
        source_ref: null,
        created_by: h.viewer.id,
      }),
      await seedHold(f, { user_id: u1, source_ref: sourceOf(sibling.id) }),
      await seedHold(f, { user_id: u4, reason: 'ledger_mismatch', source_ref: diff.id }),
      await seedHold(f, { user_id: u5, source_ref: `recon_diff:${diff.id.toUpperCase()}` }),
      await seedHold(f, { user_id: u5, source_ref: `${ref} ` }),
    ];
    const foreign = await seedHold(other, { user_id: await member(other), source_ref: ref });

    const reason = '通道账单已核对，差额由支付宝侧更正';
    const data = await closed(await h.close(diff.id, { reason }));
    expect(data.released_hold_count).toBe(3);
    await expectClosed(f, diff, h.recon.id, reason);
    expect(byId(await allHolds(f))).toEqual(
      byId([...mine.map((hold) => releasedBy(f, hold, h.recon.id)), ...untouched]),
    );
    expect(await allHolds(other)).toEqual([foreign]);
    expect(await diffNow(f, sibling.id)).toEqual(sibling);

    const releases = await audits(f, RELEASE_ACTION);
    expect(releases.map((row) => row.target).sort()).toEqual(mine.map((hold) => hold.id).sort());
    for (const row of releases) expect(row.admin_id).toBe(h.recon.id);

    const closes = await audits(f, CLOSE_ACTION);
    expect(closes).toHaveLength(1);
    const audit = closes[0]!;
    expect({ admin_id: audit.admin_id, target: audit.target }).toEqual({
      admin_id: h.recon.id,
      target: diff.id,
    });
    const before = audit.before as Record<string, unknown> | null;
    const after = audit.after as Record<string, unknown> | null;
    expect(before?.['status'], JSON.stringify(before)).toBe('open');
    expect(typeof before?.['released_hold_count'], JSON.stringify(before)).toBe('number');
    expect(after?.['status'], JSON.stringify(after)).toBe('closed');
    expect(after?.['released_hold_count'], JSON.stringify(after)).toBe(3);
    const text = JSON.stringify({ before, after });
    expect(text).toContain(reason);
    for (const userId of users) expect(text).not.toContain(userId);
    expect(await audits(f)).toHaveLength(4);

    // The sibling difference keeps its own hold until it is closed itself.
    const next = await closed(await h.close(sibling.id, { reason: '同批核对' }));
    expect(next.released_hold_count).toBe(1);
    expect(await allHolds(f)).toContainEqual(releasedBy(f, untouched[2]!, h.recon.id));
  });
});

it('[AC-B2-09b#8] 没有冻结、或来源为该单的冻结都已解除 → released_hold_count 0，已解除的记录原样不动，不写 withdraw_hold.release，只写一条 recon_diff_close（前后 released_hold_count 0）', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const bare = await seedDiff(f, { source: 'R3', type: 'ledger_mismatch', status: 'processing' });
    const spent = await seedDiff(f, { source: 'R2', type: 'channel_mismatch' });
    const old = await seedHold(f, {
      user_id: await member(f),
      source_ref: sourceOf(spent.id),
      released_at: ago(f, 15),
      released_by: h.viewer.id,
    });
    for (const diff of [bare, spent]) {
      const data = await closed(await h.close(diff.id, { reason: '无须处理' }));
      expect(data.released_hold_count).toBe(0);
      await expectClosed(f, diff, h.recon.id, '无须处理');
    }
    expect(await allHolds(f)).toEqual([old]);
    expect(await audits(f, RELEASE_ACTION)).toEqual([]);
    const closes = await audits(f, CLOSE_ACTION);
    expect(closes.map((row) => row.target)).toEqual([bare.id, spent.id]);
    for (const row of closes) {
      expect((row.after as Record<string, unknown> | null)?.['released_hold_count']).toBe(0);
      expect((row.after as Record<string, unknown> | null)?.['status']).toBe('closed');
    }
    expect((closes[0]!.before as Record<string, unknown> | null)?.['status']).toBe('processing');
  });
});
