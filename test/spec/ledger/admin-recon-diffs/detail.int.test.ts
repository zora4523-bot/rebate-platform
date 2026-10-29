// B2-09a detail rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// getAdminReconDiff (GET /admin/v1/recon-diffs/{recon_diff_id}: fund.recon or fund.view, read
// only, no step-up; the fields of a list row plus handler_id (null until handled), updated_at and
// resolution (the stored object, null while unhandled, returned as stored); an unknown id, a
// difference of another app or one of source R4 → 20001 data.fields=[recon_diff_id], no 404;
// reading writes no audit record); 08 BR-FUND-22 (处理人也可以不恢复，以「已关闭（不处理）」
// recon_diff_status=closed 结案并记原因). Requests go through the real admin entry (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  DETAIL_KEYS,
  ago,
  allAudits,
  allDiffs,
  answer,
  detailOf,
  detailView,
  fixture,
  seedDiff,
  suite,
  withReconAdmin,
} from './kit.ts';

const s = suite();
/** 2^53 − 1: the largest fen amount a JSON number carries exactly. */
const BIG = 9_007_199_254_740_991n;

it('[AC-B2-09a#8] 差错单详情（fund.recon 或 fund.view 任一即可，超管也能读）：恰好是契约的 AdminReconDiffDetail——列表行的字段加处理人 handler_id、updated_at 与 resolution 原样；已关闭（不处理）的单带处理人、结案时刻与原因，未处理的单 handler_id、closed_at、resolution 为 null，处理中的单有处理人无结案时刻；金额整数分原样', async () => {
  const f = fixture(s);
  await withReconAdmin(f, async (h) => {
    const closed = await seedDiff(f, {
      type: 'platform_restore',
      source: 'R1',
      period: '2026-10-06',
      ref_type: 'order',
      ref_id: 'taobao:5550001',
      expected_fen: 1_234n,
      actual_fen: 0n,
      diff_fen: 1_234n,
      status: 'closed',
      handler_id: h.recon.id,
      closed_at: ago(f, 15),
      resolution: {
        reason: '买家撤销退款后平台恢复，核对后不恢复',
        decision: 'not_restored',
        evidence: ['taobao:5550001', 2026],
        nested: { at: '2026-10-07T10:00:00+08:00', count: 1, ok: true, none: null },
      },
      created_at: ago(f, 120),
      updated_at: ago(f, 15),
    });
    const open = await seedDiff(f, {
      type: 'ledger_mismatch',
      source: 'R3',
      period: '2026-10-28',
      ref_type: 'account',
      expected_fen: 0n,
      actual_fen: BIG,
      diff_fen: -BIG,
      created_at: ago(f, 30),
    });
    const processing = await seedDiff(f, {
      type: 'appeal_restore',
      source: 'R3',
      period: '2026-12-01',
      ref_type: 'user',
      expected_fen: 123n,
      actual_fen: 0n,
      diff_fen: 123n,
      status: 'processing',
      handler_id: h.viewer.id,
      created_at: ago(f, 20),
      updated_at: ago(f, 5),
    });
    const root = await h.caller([], { superAdmin: true });
    for (const row of [closed, open, processing]) {
      for (const who of [h.recon, h.viewer, root]) {
        const sent = await h.detail(row.id, who);
        const data = await detailOf(sent);
        expect(Object.keys(data).sort(), sent.body).toEqual(DETAIL_KEYS);
        expect(data, sent.body).toEqual(detailView(row));
      }
    }
    const shown = await detailOf(await h.detail(open.id));
    expect({ handler_id: shown['handler_id'], closed_at: shown['closed_at'] }).toEqual({
      handler_id: null,
      closed_at: null,
    });
    expect(shown['resolution']).toBeNull();
    const amounts = [shown['expected_fen'], shown['actual_fen'], shown['diff_fen']];
    expect(amounts).toEqual([0, Number(BIG), -Number(BIG)]);
    const done = await detailOf(await h.detail(closed.id));
    expect({ status: done['status'], handler_id: done['handler_id'] }).toEqual({
      status: 'closed',
      handler_id: h.recon.id,
    });
    expect(done['closed_at']).toBe(closed.closed_at!.getTime());
    expect(done['resolution']).toEqual(closed.resolution);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09a#9] 差错单详情的拒绝：不存在的 id、其他应用的差错单、source R4 的收款差错 → 20001 data.fields=[recon_diff_id]（不回 404，三种情形的应答一样）；id 不是 UUID → 20001 [recon_diff_id]；没有 fund.recon / fund.view → 10403；不带令牌 → 10001；读取不写审计、不改差错单', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const own = await seedDiff(f, { type: 'union_mismatch', source: 'R1', ref_type: 'order' });
  const pay = await seedDiff(f, {
    type: 'pay_mismatch',
    source: 'R4',
    ref_type: 'pay_order',
    dedupe_key: `spec:${randomUUID()}`,
  });
  const foreign = await seedDiff(other, { type: 'union_mismatch', source: 'R1' });
  await withReconAdmin(f, async (h) => {
    const refusals: unknown[] = [];
    for (const id of [randomUUID(), foreign.id, pay.id]) {
      const body = await answer(await h.detail(id), 20001, { fields: ['recon_diff_id'] });
      refusals.push({ code: body.code, msg: body.msg, data: body.data });
      await answer(await h.detail(id, h.viewer), 20001, { fields: ['recon_diff_id'] });
    }
    expect(new Set(refusals.map((refusal) => JSON.stringify(refusal))).size).toBe(1);
    await answer(await h.detail('not-a-uuid'), 20001, { fields: ['recon_diff_id'] });
    await answer(await h.detail(own.id, await h.caller([])), 10403);
    await answer(await h.detail(own.id, await h.caller(['pay.view'])), 10403);
    await answer(await h.detail(own.id, await h.caller(['fund.settle_adjust'])), 10403);
    await answer(await h.detail(own.id, null), 10001);
    expect((await detailOf(await h.detail(own.id)))['recon_diff_id']).toBe(own.id);
  });
  expect(await allAudits(f)).toEqual([]);
  const after = await allDiffs(f);
  expect(after).toEqual([own, pay].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
});
