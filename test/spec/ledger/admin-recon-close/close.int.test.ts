// B2-09b close rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// closeAdminReconDiff — fund.recon only (fund.view is not enough → 10403
// data.reason=admin_permission_denied; a super admin holds every point; no step-up); order of
// checks permission → body (reason 1–200 characters after trimming, else 20001 [reason]) →
// recon_diff_id (unknown / another app / R4 → 20001 [recon_diff_id], no 404) → status (closed /
// adjusted / written_off → 20902 data.resource=recon_diff, nothing changed); effects: status closed,
// closed_at = updated_at = the server clock, handler_id the caller, resolution.reason the trimmed
// reason; the response is the detail as GET returns it after closing plus released_hold_count;
// closing posts nothing (08 BR-FUND-22 「已关闭（不处理）」以 recon_diff_status=closed 结案并记原因).
// Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  DETAIL_KEYS,
  ago,
  allDiffs,
  allHolds,
  answer,
  audits,
  chars,
  closed,
  conflict,
  denied,
  detailOf,
  detailView,
  diffNow,
  expectClosed,
  fixture,
  member,
  newKey,
  seedDiff,
  seedHold,
  sourceOf,
  suite,
  voucherCount,
  withCloseAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09b#2] 关闭结案（fund.recon，不要二次验证）：open 与 processing 的 R1 / R2 / R3 差错单都能关——status closed、handler_id 为操作人（处理中单的原处理人被替换）、closed_at 与 updated_at 为服务端时钟、resolution.reason 为去掉首尾空白的原因，其余列不变；应答恰好是 recon_diff（与关闭后 GET 详情一致）加 released_hold_count（无冻结时为 0）；关闭不记账', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const rows = [
      await seedDiff(f, {
        source: 'R1',
        type: 'union_mismatch',
        period: '2026-09',
        ref_type: 'order',
        ref_id: 'taobao:5550001',
        expected_fen: 1_234n,
        actual_fen: 1_200n,
        diff_fen: 34n,
        created_at: ago(f, 600),
        updated_at: ago(f, 600),
      }),
      await seedDiff(f, {
        source: 'R2',
        type: 'channel_mismatch',
        period: '2026-10-28',
        ref_type: 'withdrawal',
        status: 'processing',
        handler_id: h.viewer.id,
        dedupe_key: `spec:${randomUUID()}`,
        resolution: { channel_order_id: '20261028110070001500000000001', note: '待核对' },
        created_at: ago(f, 300),
        updated_at: ago(f, 60),
      }),
      await seedDiff(f, {
        source: 'R3',
        type: 'ledger_mismatch',
        period: '2026-10-28',
        ref_type: 'account',
        created_at: ago(f, 120),
        updated_at: ago(f, 120),
      }),
      await seedDiff(f, {
        source: 'R3',
        type: 'appeal_restore',
        period: '2026-10-27',
        ref_type: 'order',
        status: 'processing',
        handler_id: h.recon.id,
        created_at: ago(f, 90),
        updated_at: ago(f, 45),
      }),
    ];
    for (const row of rows) {
      const reason = `  核对无误（${row.source} ${row.type}），差额由对方调整\t\n`;
      const sent = await h.close(row.id, { reason });
      const data = await closed(sent);
      expect(data.released_hold_count, sent.body).toBe(0);
      const now = await expectClosed(f, row, h.recon.id, reason.trim());
      expect(Object.keys(data.recon_diff).sort(), sent.body).toEqual(DETAIL_KEYS);
      expect(data.recon_diff, sent.body).toEqual(detailView(now));
      expect(await detailOf(await h.detail(row.id))).toEqual(data.recon_diff);
    }
    expect(await voucherCount(f)).toBe(0);
  });
});

it('[AC-B2-09b#3] 权限：只有 fund.recon（或超管）能关；只有 fund.view、没有权限点、只有别的权限点 → 10403 data.reason=admin_permission_denied（原因全空白也先判权限）；不带令牌 → 10001；被拒时差错单、冻结记录都不变，不写审计', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await seedDiff(f, {
      source: 'R2',
      type: 'channel_mismatch',
      ref_type: 'withdrawal',
    });
    const hold = await seedHold(f, { user_id: await member(f), source_ref: sourceOf(diff.id) });
    const outsiders = [
      h.viewer,
      await h.caller([]),
      await h.caller(['pay.view', 'risk.freeze', 'fund.settle_adjust']),
    ];
    for (const caller of outsiders) {
      await denied(await h.close(diff.id, { reason: '越权尝试' }, { caller }));
      await denied(await h.close(diff.id, { reason: '   ' }, { caller }));
    }
    await answer(await h.close(diff.id, { reason: '未登录' }, { caller: null }), 10001);
    expect(await diffNow(f, diff.id)).toEqual(diff);
    expect(await allHolds(f)).toEqual([hold]);
    expect(await audits(f)).toEqual([]);

    const root = await h.caller([], { superAdmin: true });
    const data = await closed(await h.close(diff.id, { reason: '超管结案' }, { caller: root }));
    expect(data.released_hold_count).toBe(1);
    await expectClosed(f, diff, root.id, '超管结案');
  });
});

it('[AC-B2-09b#4] 原因：空串、全空白、去空白后超过 200 字、缺 reason → 20001 data.fields=[reason]，什么都不改；恰好 200 字可以关并原样记入 resolution.reason；原因不合格时先于差错单 id 与状态报 [reason]', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await seedDiff(f, { source: 'R1', type: 'union_mismatch', ref_type: 'order' });
    const done = await seedDiff(f, {
      status: 'closed',
      handler_id: h.recon.id,
      closed_at: ago(f, 30),
      resolution: { reason: '早已结案' },
    });
    const bad: unknown[] = [{ reason: '' }, { reason: ' \t \n ' }, { reason: chars(201) }, {}];
    for (const body of bad) {
      await answer(await h.close(diff.id, body), 20001, { fields: ['reason'] });
    }
    for (const target of [randomUUID(), done.id]) {
      await answer(await h.close(target, { reason: '   ' }), 20001, { fields: ['reason'] });
    }
    expect(await allDiffs(f)).toEqual([diff, done].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(await audits(f)).toEqual([]);

    const data = await closed(await h.close(diff.id, { reason: chars(200) }));
    expect(data.released_hold_count).toBe(0);
    await expectClosed(f, diff, h.recon.id, chars(200));
  });
});

it('[AC-B2-09b#5] 差错单 id：不存在的 id、其他应用的差错单、source R4 的收款差错、不是 UUID 的 id → 20001 data.fields=[recon_diff_id]（不回 404，前三种应答一样）；这些单与其冻结记录都不动，不写审计', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const foreign = await seedDiff(other, { source: 'R2', type: 'channel_mismatch' });
    const pay = await seedDiff(f, {
      source: 'R4',
      type: 'pay_mismatch',
      ref_type: 'pay_order',
      dedupe_key: `spec:${randomUUID()}`,
    });
    const foreignHold = await seedHold(other, {
      user_id: await member(other),
      source_ref: sourceOf(foreign.id),
    });
    const payHold = await seedHold(f, { user_id: await member(f), source_ref: sourceOf(pay.id) });
    const refusals: unknown[] = [];
    for (const id of [randomUUID(), foreign.id, pay.id]) {
      const body = await answer(await h.close(id, { reason: '核对' }), 20001, {
        fields: ['recon_diff_id'],
      });
      refusals.push({ code: body.code, msg: body.msg, data: body.data });
    }
    expect(new Set(refusals.map((refusal) => JSON.stringify(refusal))).size).toBe(1);
    await answer(await h.close('not-a-uuid', { reason: '核对' }), 20001, {
      fields: ['recon_diff_id'],
    });
    expect(await allDiffs(f)).toEqual([pay]);
    expect(await allDiffs(other)).toEqual([foreign]);
    expect(await allHolds(f)).toEqual([payHold]);
    expect(await allHolds(other)).toEqual([foreignHold]);
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-09b#6] 已 closed / adjusted / written_off 的差错单 → 20902 data.resource=recon_diff：差错单不变、来源为它的未解除冻结仍不解除、不写审计；20902 不存为幂等结果（同一 Idempotency-Key 再发仍是 20902）', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    for (const status of ['closed', 'adjusted', 'written_off'] as const) {
      const diff = await seedDiff(f, {
        source: 'R2',
        type: 'channel_mismatch',
        ref_type: 'withdrawal',
        status,
        handler_id: h.viewer.id,
        closed_at: ago(f, 20),
        resolution: { reason: `已${status}` },
        created_at: ago(f, 200),
        updated_at: ago(f, 20),
      });
      const hold = await seedHold(f, { user_id: await member(f), source_ref: sourceOf(diff.id) });
      const key = newKey();
      await conflict(await h.close(diff.id, { reason: '再关一次' }, { key }));
      await conflict(await h.close(diff.id, { reason: '再关一次' }, { key }));
      expect(await diffNow(f, diff.id)).toEqual(diff);
      expect((await allHolds(f)).find((row) => row.id === hold.id)).toEqual(hold);
    }
    expect(await audits(f)).toEqual([]);
  });
});
