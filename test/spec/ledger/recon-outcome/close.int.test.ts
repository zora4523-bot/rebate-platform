// B2-09h close rule tests (claude-independent, SPEC_REF 9ab94dc0): contracts/openapi.yaml
// closeAdminReconDiff — `outcome`, optional, union or ours, meaningful for type=settle_amount_mismatch
// of source R1 only (D10-506 ①); a value outside the enum is 20001 [outcome]; order of checks
// fund.recon → body → recon_diff_id → status (20902) → outcome on any other type or source (20001
// [outcome], nothing changed); stored as resolution.outcome next to resolution.reason; without it
// there is no structured conclusion; a closed difference answers 20902 to any further close, so the
// conclusion cannot be changed; the audit recon_diff_close carries outcome when given. Requests go
// through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CLOSE_ACTION,
  OUTCOMES,
  ago,
  allDiffs,
  answer,
  auditText,
  audits,
  closed,
  conflict,
  denied,
  detailOf,
  detailView,
  diffNow,
  expectConcluded,
  fixture,
  holdNow,
  member,
  newKey,
  r1Diff,
  seedDiff,
  seedHold,
  sourceOf,
  suite,
  unionKeys,
  voucherCount,
  withCloseAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09h#1] R1 账单金额不一致差错单带 outcome 结案（open、processing）：resolution 恰好是原有键加 reason、outcome，其余列按结案规则变化；应答 recon_diff 与关闭后 GET 详情一致且带 resolution.outcome；关闭不记账；结案后读口只认其中 outcome=union 的单', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const cases = [
      { outcome: 'union', status: 'open', stored: null },
      { outcome: 'union', status: 'processing', stored: { note: '财务核实中' } },
      { outcome: 'ours', status: 'open', stored: null },
      { outcome: 'ours', status: 'processing', stored: { note: '财务核实中' } },
    ];
    const keys: string[] = [];
    const concluded: string[] = [];
    for (const [i, one] of cases.entries()) {
      const diff = await r1Diff(f, {
        status: one.status,
        handler_id: one.status === 'processing' ? h.viewer.id : null,
        resolution: one.stored,
      });
      keys.push(diff.ref_id);
      if (one.outcome === 'union') concluded.push(diff.ref_id);
      const reason = `  核对联盟结算明细（第 ${i + 1} 张）\t\n`;
      const sent = await h.close(diff.id, { reason, outcome: one.outcome });
      const data = await closed(sent);
      expect(data.released_hold_count, sent.body).toBe(0);
      const now = await expectConcluded(f, diff, h.recon.id, {
        ...one.stored,
        reason: reason.trim(),
        outcome: one.outcome,
      });
      expect(data.recon_diff, sent.body).toEqual(detailView(now));
      expect(await detailOf(await h.detail(diff.id))).toEqual(data.recon_diff);
    }
    expect(await voucherCount(f)).toBe(0);
    expect(await unionKeys(f.db, f.appId, keys)).toEqual([...concluded].sort());
  });
});

it('[AC-B2-09h#2] 不是 R1 账单金额不一致单带 outcome（union、ours）→ 20001 data.fields=[outcome]：R1 的别的类型（settle_missing、union_mismatch、estimate_changed_after_credit）、R2、R3（含 ref_type order 与类型相同而来源不是 R1 的单）都一样，差错单、冻结都不变，不写审计；这个拒绝不存为幂等结果，同一 Idempotency-Key 去掉 outcome 重发照常关闭', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const rows = [
      await r1Diff(f, { type: 'settle_missing', actual_fen: 0n, diff_fen: -1_234n }),
      await r1Diff(f, { type: 'union_mismatch', expected_fen: 0n, diff_fen: 1_100n }),
      await r1Diff(f, { type: 'estimate_changed_after_credit' }),
      await seedDiff(f, { source: 'R2', type: 'channel_mismatch', ref_type: 'withdrawal' }),
      await seedDiff(f, {
        source: 'R3',
        type: 'ledger_mismatch',
        ref_type: 'account',
        status: 'processing',
        handler_id: h.viewer.id,
      }),
      await seedDiff(f, { source: 'R3', type: 'appeal_restore', ref_type: 'order' }),
      await r1Diff(f, { source: 'R3' }),
    ];
    for (const [i, row] of rows.entries()) {
      const hold = await seedHold(f, { user_id: await member(f), source_ref: sourceOf(row.id) });
      const key = newKey();
      for (const outcome of OUTCOMES) {
        const sent = await h.close(row.id, { reason: '核对', outcome }, { key });
        await answer(sent, 20001, { fields: ['outcome'] });
      }
      expect(await diffNow(f, row.id)).toEqual(row);
      expect(await holdNow(f, hold)).toEqual(hold);
      expect(await audits(f, CLOSE_ACTION)).toHaveLength(i);

      const data = await closed(await h.close(row.id, { reason: '核对' }, { key }));
      expect(data.released_hold_count).toBe(1);
      await expectConcluded(f, row, h.recon.id, { reason: '核对' });
    }
  });
});

it('[AC-B2-09h#3] 检查顺序：权限 → 请求体 → recon_diff_id → 状态 → outcome 的适用范围。持 fund.view → 10403；原因不合格 → [reason]；未知 id、别的应用、R4、不是 UUID → [recon_diff_id]；不适用 outcome 的单（R2、R1 的别的类型）已 closed / adjusted / written_off → 20902（不是 [outcome]），差错单不变；只有仍可关闭的这类单才到 [outcome]', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const body = { reason: '核对', outcome: 'union' };
    const open = await seedDiff(f, { source: 'R2', type: 'channel_mismatch' });
    const missing = await r1Diff(f, { type: 'settle_missing' });
    const foreign = await seedDiff(other, { source: 'R2', type: 'channel_mismatch' });
    const pay = await seedDiff(f, {
      source: 'R4',
      type: 'pay_mismatch',
      ref_type: 'pay_order',
      dedupe_key: `spec:${randomUUID()}`,
    });

    await denied(await h.close(open.id, body, { caller: h.viewer }));
    await answer(await h.close(open.id, { ...body, reason: '   ' }), 20001, { fields: ['reason'] });
    for (const id of [randomUUID(), foreign.id, pay.id, 'not-a-uuid']) {
      await answer(await h.close(id, body), 20001, { fields: ['recon_diff_id'] });
    }
    for (const status of ['closed', 'adjusted', 'written_off'] as const) {
      const finished = {
        status,
        handler_id: h.viewer.id,
        closed_at: ago(f, 20),
        resolution: { reason: `已${status}` },
      };
      for (const done of [
        await seedDiff(f, { source: 'R2', type: 'channel_mismatch', ...finished }),
        await r1Diff(f, { type: 'settle_missing', ...finished }),
      ]) {
        await conflict(await h.close(done.id, body));
        expect(await diffNow(f, done.id)).toEqual(done);
      }
    }
    expect(await audits(f)).toEqual([]);

    for (const row of [open, missing]) {
      await answer(await h.close(row.id, body), 20001, { fields: ['outcome'] });
      expect(await diffNow(f, row.id)).toEqual(row);
    }
  });
});

it('[AC-B2-09h#4] outcome 不在枚举内（大小写不同、别的词、空串、首尾空白、null、数字、布尔、数组、对象）→ 20001 data.fields=[outcome]，未知字段报字段名：什么都不改、不写审计；随后合法的 outcome 照常写入', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await r1Diff(f);
    const bad: unknown[] = [
      'UNION',
      'Union',
      'both',
      '以联盟为准',
      '',
      ' union',
      null,
      1,
      true,
      ['union'],
      { value: 'union' },
    ];
    for (const outcome of bad) {
      await answer(await h.close(diff.id, { reason: '核对', outcome }), 20001, {
        fields: ['outcome'],
      });
    }
    await answer(await h.close(diff.id, { reason: '核对', conclusion: 'union' }), 20001, {
      fields: ['conclusion'],
    });
    expect(await allDiffs(f)).toEqual([diff]);
    expect(await audits(f)).toEqual([]);

    await closed(await h.close(diff.id, { reason: '核对', outcome: 'ours' }));
    await expectConcluded(f, diff, h.recon.id, { reason: '核对', outcome: 'ours' });
  });
});

it('[AC-B2-09h#5] 不传 outcome 行为不变（R1、R2、R3）：resolution 只多 reason、没有 outcome 键，审计没有 outcome，读口不算；同样的结案带 outcome 时只多这一个键', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const reason = '核对无误';
    const rows = [
      await r1Diff(f),
      await r1Diff(f, { resolution: { note: '财务核实中' } }),
      await seedDiff(f, { source: 'R2', type: 'channel_mismatch' }),
      await seedDiff(f, { source: 'R3', type: 'ledger_mismatch' }),
    ];
    for (const row of rows) {
      const data = await closed(await h.close(row.id, { reason }));
      const stored = row.resolution as Record<string, unknown> | null;
      const now = await expectConcluded(f, row, h.recon.id, { ...stored, reason });
      expect(data.recon_diff).toEqual(detailView(now));
    }
    for (const record of await audits(f, CLOSE_ACTION)) {
      expect(auditText(record)).not.toContain('"outcome"');
    }
    const keys = rows.map((row) => row.ref_id);
    expect(await unionKeys(f.db, f.appId, keys)).toEqual([]);

    const twin = await r1Diff(f);
    await closed(await h.close(twin.id, { reason, outcome: 'ours' }));
    await expectConcluded(f, twin, h.recon.id, { reason, outcome: 'ours' });
  });
});

it('[AC-B2-09h#6] 结论不可改：已结案的 R1 单再关（换 outcome、同 outcome、不传）→ 20902 data.resource=recon_diff，resolution 与读口结果都不变、不再写审计；已 adjusted / written_off 的 R1 单带 outcome 同样 20902', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    for (const status of ['adjusted', 'written_off'] as const) {
      const done = await r1Diff(f, {
        status,
        handler_id: h.viewer.id,
        closed_at: ago(f, 20),
        resolution: { reason: `已${status}` },
      });
      await conflict(await h.close(done.id, { reason: '补结论', outcome: 'union' }));
      expect(await diffNow(f, done.id)).toEqual(done);
    }

    const diff = await r1Diff(f);
    const reason = '以联盟结算额为准';
    await closed(await h.close(diff.id, { reason, outcome: 'union' }));
    const after = await expectConcluded(f, diff, h.recon.id, { reason, outcome: 'union' });
    const again = [
      { reason: '改判', outcome: 'ours' },
      { reason: '重复', outcome: 'union' },
      { reason: '撤销结论' },
    ];
    for (const body of again) await conflict(await h.close(diff.id, body));
    expect(await diffNow(f, diff.id)).toEqual(after);
    expect(await audits(f, CLOSE_ACTION)).toHaveLength(1);
    expect(await unionKeys(f.db, f.appId, [diff.ref_id])).toEqual([diff.ref_id]);
  });
});

it('[AC-B2-09h#7] 审计 recon_diff_close 带 outcome（union、ours 各一）：操作人、目标、前后 status 与 released_hold_count、reason 照旧，没有个人信息；同一批里不传 outcome 的单审计没有这个键', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    for (const outcome of OUTCOMES) {
      const diff = await r1Diff(f);
      const userId = await member(f);
      await seedHold(f, { user_id: userId, source_ref: sourceOf(diff.id) });
      const reason = `联盟结算明细已核对（${outcome}）`;
      const data = await closed(await h.close(diff.id, { reason, outcome }));
      expect(data.released_hold_count).toBe(1);

      const records = (await audits(f, CLOSE_ACTION)).filter((row) => row.target === diff.id);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.admin_id).toBe(h.recon.id);
      const before = record.before as Record<string, unknown> | null;
      const after = record.after as Record<string, unknown> | null;
      expect(before?.['status'], JSON.stringify(before)).toBe('open');
      expect(after?.['status'], JSON.stringify(after)).toBe('closed');
      expect(after?.['released_hold_count'], JSON.stringify(after)).toBe(1);
      const text = auditText(record);
      expect(text).toContain(reason);
      expect(text).toContain(`"outcome":"${outcome}"`);
      expect(text).not.toContain(userId);
    }

    const plain = await r1Diff(f);
    await closed(await h.close(plain.id, { reason: '不下结论' }));
    const records = (await audits(f, CLOSE_ACTION)).filter((row) => row.target === plain.id);
    expect(records).toHaveLength(1);
    expect(auditText(records[0]!)).not.toContain('"outcome"');
  });
});
