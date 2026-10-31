// B2-09g restore rule tests, the refusals (claude-independent, SPEC_REF 81273415):
// contracts/openapi.yaml restoreAdminReconDiff — order of checks order.restore (10403
// data.reason=admin_permission_denied; a super admin holds every point) → step-up totp (10003
// data.tier=totp) → body (note 1–200 characters after trimming, else 20001 [note]) →
// recon_diff_id (unknown / another app / R4 / not a uuid → 20001 [recon_diff_id], no 404) → status
// (adjusted / written_off / closed → 20902 resource=recon_diff) → not an account-appeal restore
// (20001 [recon_diff_id] reason=restore_not_supported) → the member deleted (reason
// restore_user_deleted, D10-469 ①; 12 §4.8: also one already in deletion processing). Every refusal
// changes nothing; 2xxxx refusals are not stored as idempotent results. Requests go through the
// real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  RESTORE,
  answer,
  chars,
  conflict,
  denied,
  everything,
  expectRestored,
  fixture,
  idempotencyRows,
  memberOf,
  newKey,
  refused,
  restoreResolution,
  restored,
  seedCase,
  seedDiff,
  seedOrder,
  seedRestoreDiff,
  stepUpRequired,
  suite,
  unknownDiff,
  withRestoreAdmin,
  type DiffRow,
} from './kit.ts';

const s = suite();

it('[AC-B2-09g#2] 权限：只有 order.restore（或超管）能处理；只有 fund.recon / fund.view、没有权限点、只有别的权限点 → 10403 data.reason=admin_permission_denied（note 全空白、不带二次验证也先判权限）；不带令牌 → 10001；被拒时什么都不变', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  await withRestoreAdmin(f, async (h) => {
    const before = await everything(f);
    const outsiders = [
      h.viewer,
      await h.caller([]),
      await h.caller(['payout.execute', 'fund.settle_adjust', 'order.hold']),
    ];
    for (const caller of outsiders) {
      await denied(await h.restore(c.diff.id, {}, { caller }));
      await denied(await h.restore(c.diff.id, { note: '   ' }, { caller, stepUp: null }));
    }
    await answer(await h.restore(c.diff.id, {}, { caller: null }), 10001);
    expect(await everything(f)).toEqual(before);

    const root = await h.caller([], { superAdmin: true });
    expect((await restored(await h.restore(c.diff.id, {}, { caller: root }))).restored_fen).toBe(
      85,
    );
  });
});

it('[AC-B2-09g#3] 二次验证（totp 档）：不带 X-Step-Up-Token、令牌是别的账号的、令牌是短信档的 → 10003 data.tier=totp，先于请求体与差错单检查；什么都不变；令牌不进请求体哈希，拿到令牌后用同一 Idempotency-Key 重放即成功', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  await withRestoreAdmin(f, async (h) => {
    const before = await everything(f);
    const key = newKey();
    const colleague = await h.caller([RESTORE]);
    await stepUpRequired(await h.restore(c.diff.id, {}, { key, stepUp: null }));
    await stepUpRequired(
      await h.restore(c.diff.id, {}, { key, stepUp: await h.stepUp(colleague) }),
    );
    await stepUpRequired(
      await h.restore(c.diff.id, {}, { key, stepUp: await h.stepUp(h.operator, 'sms') }),
    );
    await stepUpRequired(await h.restore(c.diff.id, { note: '   ' }, { stepUp: null }));
    await stepUpRequired(await h.restore(randomUUID(), {}, { stepUp: null }));
    expect(await everything(f)).toEqual(before);

    expect((await restored(await h.restore(c.diff.id, {}, { key }))).restored_fen).toBe(85);
  });
});

it('[AC-B2-09g#4] 请求体：note 去空白后为空、超过 200 字 → 20001 data.fields=[note]；请求体不合格时先于差错单 id 报；控制台不传金额，多带的键被拒；什么都不变；恰好 200 字的 note 可以处理并记入 resolution.note；请求体 {} 也可以处理且不加 note', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  const plain = await seedCase(f);
  await withRestoreAdmin(f, async (h) => {
    const before = await everything(f);
    for (const note of ['   ', ' \t\n ', chars(201)]) {
      await answer(await h.restore(c.diff.id, { note }), 20001, { fields: ['note'] });
    }
    await answer(await h.restore(randomUUID(), { note: '   ' }), 20001, { fields: ['note'] });
    await answer(await h.restore(c.diff.id, { restored_fen: 999_999 }), 20001);
    expect(await everything(f)).toEqual(before);

    await restored(await h.restore(c.diff.id, { note: chars(200) }));
    await expectRestored(f, c.diff, {
      adminId: h.operator.id,
      paid: { direct: 85n },
      note: chars(200),
    });
    await restored(await h.restore(plain.diff.id, {}));
    await expectRestored(f, plain.diff, { adminId: h.operator.id, paid: { direct: 85n } });
  });
});

it('[AC-B2-09g#5] 差错单 id：不存在的 id、其他应用的差错单、source R4 的收款差错、不是 UUID 的 id → 20001 data.fields=[recon_diff_id]（不回 404，前三种应答一样，不带 reason）；两个应用都什么都不变', async () => {
  const f = await fixture(s);
  const other = await fixture(s);
  const foreign = await seedCase(other);
  const pay = await seedDiff(f, {
    source: 'R4',
    type: 'pay_mismatch',
    ref_type: 'pay_order',
    dedupe_key: `spec:${randomUUID()}`,
  });
  await withRestoreAdmin(f, async (h) => {
    const before = await everything(f);
    const foreignBefore = await everything(other);
    const refusals: unknown[] = [];
    for (const id of [randomUUID(), foreign.diff.id, pay.id]) {
      const body = await unknownDiff(await h.restore(id));
      refusals.push({ code: body.code, msg: body.msg, data: body.data });
    }
    expect(new Set(refusals.map((refusal) => JSON.stringify(refusal))).size).toBe(1);
    await unknownDiff(await h.restore('not-a-uuid'));
    expect(await everything(f)).toEqual(before);
    expect(await everything(other)).toEqual(foreignBefore);
  });
});

it('[AC-B2-09g#6] 已 adjusted / written_off / closed 的差错单 → 20902 data.resource=recon_diff（先于是否申诉恢复的判断）：差错单、账务都不动；20902 不存为幂等结果（同一 key 再发仍是 20902）', async () => {
  const f = await fixture(s);
  await withRestoreAdmin(f, async (h) => {
    for (const status of ['adjusted', 'written_off', 'closed'] as const) {
      const handled = {
        status,
        handler_id: h.viewer.id,
        closed_at: new Date(f.clock.now().getTime() - 20 * 60_000),
      };
      const order = await seedOrder(f);
      const appeal = await seedRestoreDiff(f, order, { patch: handled });
      const platform = await seedDiff(f, {
        type: 'platform_restore',
        ref_type: 'order',
        ...handled,
      });
      const before = await everything(f);
      for (const id of [appeal.id, platform.id]) {
        const key = newKey();
        await conflict(await h.restore(id, {}, { key }));
        await conflict(await h.restore(id, {}, { key }));
        expect((await idempotencyRows(f)).filter((row) => row.key === key)).toEqual([]);
      }
      expect(await everything(f)).toEqual(before);
    }
  });
});

it('[AC-B2-09g#7] 不是账户申诉恢复的差错单 → 20001 data.fields=[recon_diff_id] reason=restore_not_supported：platform_restore、ledger_mismatch、type 不是 appeal_restore 而 resolution 像申诉恢复的、resolution 为空、reason_code 不是 APPEAL_RESTORE、缺 user_id、缺 shares、shares 为空；先于注销判断（resolution 的会员已注销仍报 restore_not_supported）；什么都不变', async () => {
  const f = await fixture(s);
  const order = await seedOrder(f);
  const person = order.people.find((p) => p.forfeited)!;
  const good = restoreResolution(order, person.userId, [person]);
  const without = (key: string) =>
    Object.fromEntries(Object.entries(good).filter(([name]) => name !== key));
  const gone = await memberOf(f, 'deleted');
  const unsupported = [
    await seedDiff(f, { type: 'platform_restore', ref_type: 'order', ref_id: order.orderKey }),
    await seedDiff(f, { type: 'ledger_mismatch' }),
    await seedDiff(f, { type: 'platform_restore', ref_type: 'order', resolution: good }),
    await seedDiff(f, { type: 'appeal_restore', ref_type: 'order', resolution: null }),
    await seedDiff(f, {
      type: 'appeal_restore',
      ref_type: 'order',
      resolution: { ...good, reason_code: 'OTHER' },
    }),
    await seedDiff(f, {
      type: 'appeal_restore',
      ref_type: 'order',
      resolution: without('reason_code'),
    }),
    await seedDiff(f, {
      type: 'appeal_restore',
      ref_type: 'order',
      resolution: without('user_id'),
    }),
    await seedDiff(f, { type: 'appeal_restore', ref_type: 'order', resolution: without('shares') }),
    await seedDiff(f, {
      type: 'appeal_restore',
      ref_type: 'order',
      resolution: { ...good, shares: [] },
    }),
    await seedDiff(f, {
      type: 'platform_restore',
      ref_type: 'order',
      resolution: { ...good, user_id: gone },
    }),
  ];
  await withRestoreAdmin(f, async (h) => {
    const before = await everything(f);
    for (const diff of unsupported) {
      const key = newKey();
      await refused(await h.restore(diff.id, {}, { key }), 'restore_not_supported');
      expect((await idempotencyRows(f)).filter((row) => row.key === key)).toEqual([]);
    }
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09g#8] 依 D10-469 ①：受益人已注销（users.status=deleted）或已进入注销处理（deleting，12 §4.8「不写其账户」）→ 20001 data.fields=[recon_diff_id] reason=restore_user_deleted：不写分录、不追加事件、差错单不动，不存为幂等结果', async () => {
  const f = await fixture(s);
  const cases: DiffRow[] = [];
  for (const status of ['deleted', 'deleting'] as const) {
    const userId = await memberOf(f, status);
    const order = await seedOrder(f, {
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, userId, forfeited: true },
      ],
    });
    cases.push(await seedRestoreDiff(f, order));
  }
  await withRestoreAdmin(f, async (h) => {
    const before = await everything(f);
    for (const diff of cases) {
      const key = newKey();
      await refused(await h.restore(diff.id, {}, { key }), 'restore_user_deleted');
      expect((await idempotencyRows(f)).filter((row) => row.key === key)).toEqual([]);
    }
    expect(await everything(f)).toEqual(before);
  });
});
