// B2-09ga restore of an identified minor (claude-independent, SPEC_REF 9ab94dc0): 编排裁定 D10-482,
// 08 BR-FUND-22 ③, BR-CALC-13, BR-ID-26 — at the restore, a promotion share (share / direct /
// indirect) of a member identified as under 18 is not paid and gets a forfeited event with reason
// minor instead of the active one; the self share is paid as usual; once the member has turned 18
// the restore is as usual. The difference reaches adjusted either way and what it reports excludes
// the unpaid share. The instant is the restore's, the identification is the BeneficiaryGate's
// (B1-03zc minors port), reached through the real admin entry and real field ciphers.
// Expected amounts are written by hand (default order of ../admin-recon-restore/kit.ts: self 425,
// direct 85 forfeited for banned at the credit, indirect 42). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ADULT_BIRTH,
  MINOR_BIRTH,
  RESTORE_ACTION,
  audits,
  available,
  expectClawbacks,
  expectRestored,
  fixture,
  forfeitedOf,
  identify,
  judged,
  memberOf,
  netOf,
  netsOf,
  partialRights,
  restoreKey,
  restoreLines,
  restoreVouchers,
  restored,
  seedCase,
  setRisk,
  shareEvents,
  suite,
  voucherKeysOf,
  voucherLines,
  withAdmin,
  type Role,
  type SeededCase,
  type StateFixture,
} from './kit.ts';

const s = suite();

/** The events appended after `count`, as [user, role, status, reason]. */
async function addedEvents(f: StateFixture, orderId: string, count: number): Promise<unknown[][]> {
  const rows = await shareEvents(f, orderId);
  return rows.slice(count).map((e) => [e.user_id, e.role, e.status, e.reason]);
}

it('[AC-B2-09ga#16] D10-482：封禁 + 已识别未成年的直推份额恢复时不补发，改追加 forfeited（minor）：实发 0、无 RESTORE 凭证、余额与净额不变、不追加 active；差错单到 adjusted、resolution.restore 仍只列 role 与 restored_fen；审计恰一条、restored_fen 为 0；之后仍判定为被剥夺，读取列出 minor', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  await identify(f, c.userId, { birth: MINOR_BIRTH });
  const count = (await shareEvents(f, c.order.orderId)).length;
  const netsBefore = await netsOf(f, c.order.orderKey);

  await withAdmin(f, async (h) => {
    const data = await restored(await h.restore(c.diff.id));
    expect(data.restored_fen).toBe(0);
    await expectRestored(f, c.diff, { adminId: h.operator.id, paid: { direct: 0n } });
    expect(await restoreVouchers(f)).toEqual([]);
    expect(await available(f, c.userId)).toBe(0n);
    expect(await netsOf(f, c.order.orderKey)).toEqual(netsBefore);
    expect(await addedEvents(f, c.order.orderId, count)).toEqual([
      [c.userId, 'direct', 'forfeited', 'minor'],
    ]);
    expect((await shareEvents(f, c.order.orderId)).at(-1)?.created_at).toEqual(f.clock.now());
    const records = await audits(f, RESTORE_ACTION);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0]!.after)).toMatch(/"restored_fen":"?0"?[,}]/);
  });

  expect(await judged(f, c.order.orderId, c.userId, 'direct')).toBe(true);
  const listed = await forfeitedOf(f, c.order.orderId);
  expect(listed.map((e) => e.reason)).toContain('minor');
});

it('[AC-B2-09ga#17] D10-482「自购照常」：同一差错单列出同一未成年的 self 与 direct → self 补发 425、追加 active；direct 不补发、追加 forfeited（minor）；restored_fen 为 425，只有 self 一条 RESTORE 凭证', async () => {
  const f = await fixture(s);
  const userId = await memberOf(f);
  await identify(f, userId, { birth: MINOR_BIRTH });
  const c = await seedCase(f, {
    people: [
      { role: 'self', ratioBp: 5000, userId, forfeited: true },
      { role: 'direct', ratioBp: 1000, userId, forfeited: true },
      { role: 'indirect', ratioBp: 500 },
    ],
  });
  const count = (await shareEvents(f, c.order.orderId)).length;

  await withAdmin(f, async (h) => {
    expect((await restored(await h.restore(c.diff.id))).restored_fen).toBe(425);
    await expectRestored(f, c.diff, { adminId: h.operator.id, paid: { self: 425n, direct: 0n } });
    const key = restoreKey(c.order.orderKey, userId, 'self', c.diff.id);
    expect((await restoreVouchers(f)).map((v) => v.uniq_key)).toEqual([key]);
    expect(await available(f, userId)).toBe(425n);
    const added = await addedEvents(f, c.order.orderId, count);
    expect(added).toHaveLength(2);
    expect(added).toEqual(
      expect.arrayContaining([
        [userId, 'self', 'active', null],
        [userId, 'direct', 'forfeited', 'minor'],
      ]),
    );
  });

  expect(await judged(f, c.order.orderId, userId, 'self')).toBe(false);
  expect(await judged(f, c.order.orderId, userId, 'direct')).toBe(true);
});

it('[AC-B2-09ga#18] D10-482 四种角色：未成年的 share / direct / indirect 都不补发、都追加 forfeited（minor），self 按快照比例补发 425、追加 active', async () => {
  const f = await fixture(s);
  const rows: readonly (readonly [Role, number, bigint])[] = [
    ['share', 5000, 0n],
    ['direct', 1000, 0n],
    ['indirect', 500, 0n],
    ['self', 5000, 425n],
  ];
  const cases: {
    readonly c: SeededCase;
    readonly role: Role;
    readonly fen: bigint;
    readonly count: number;
  }[] = [];
  for (const [role, ratioBp, fen] of rows) {
    const c = await seedCase(f, { people: [{ role, ratioBp, forfeited: true }] });
    await identify(f, c.userId, { birth: MINOR_BIRTH });
    cases.push({ c, role, fen, count: (await shareEvents(f, c.order.orderId)).length });
  }

  await withAdmin(f, async (h) => {
    for (const { c, role, fen, count } of cases) {
      expect((await restored(await h.restore(c.diff.id))).restored_fen, role).toBe(Number(fen));
      expect(await available(f, c.userId), role).toBe(fen);
      expect(await addedEvents(f, c.order.orderId, count), role).toEqual([
        role === 'self' ? [c.userId, role, 'active', null] : [c.userId, role, 'forfeited', 'minor'],
      ]);
    }
    expect((await restoreVouchers(f)).map((v) => v.uniq_key)).toEqual([
      restoreKey(cases[3]!.c.order.orderKey, cases[3]!.c.userId, 'self', cases[3]!.c.diff.id),
    ]);
  });
});

it('[AC-B2-09ga#19] D10-482 优先于 D10-469 ②：未成年在恢复时又被封禁、冻结或申诉中，推广份额同样不补发，原因是 minor 不是 banned；风控状态不变', async () => {
  const f = await fixture(s);
  const states = ['banned', 'frozen', 'appealing'] as const;
  const cases: {
    readonly c: SeededCase;
    readonly state: (typeof states)[number];
    readonly count: number;
  }[] = [];
  for (const state of states) {
    const c = await seedCase(f);
    await identify(f, c.userId, { birth: MINOR_BIRTH });
    await setRisk(f, c.userId, state);
    cases.push({ c, state, count: (await shareEvents(f, c.order.orderId)).length });
  }

  await withAdmin(f, async (h) => {
    for (const { c, state, count } of cases) {
      expect((await restored(await h.restore(c.diff.id))).restored_fen, state).toBe(0);
      expect(await available(f, c.userId), state).toBe(0n);
      expect(await addedEvents(f, c.order.orderId, count), state).toEqual([
        [c.userId, 'direct', 'forfeited', 'minor'],
      ]);
      const risk = await f.db
        .selectFrom('user_risk_state')
        .select('state')
        .where('app_id', '=', f.appId)
        .where('user_id', '=', c.userId)
        .executeTakeFirstOrThrow();
      expect(risk.state).toBe(state);
    }
  });
});

it('[AC-B2-09ga#20] D10-482「满 18 周岁后的恢复照常」，按恢复时刻判定（BR-ID-26：18 岁生日次日 00:00 +08:00）：2008-10-29 生，2026-10-29T15:59:59.999Z 恢复不补发、追加 forfeited（minor）；2026-10-29T16:00:00.000Z 恢复另一单补发 85、追加 active；两张差错单都 adjusted', async () => {
  const f = await fixture(s);
  // Set before the admin session exists: the session's idle window runs on this clock.
  f.clock.set('2026-10-29T15:59:59.999Z');
  const userId = await memberOf(f);
  await identify(f, userId, { birth: '2008-10-29' });
  const people = [
    { role: 'self', ratioBp: 5000 },
    { role: 'direct', ratioBp: 1000, userId, forfeited: true },
  ] as const;
  const under = await seedCase(f, { people });
  const turned = await seedCase(f, { people });
  const underCount = (await shareEvents(f, under.order.orderId)).length;
  const turnedCount = (await shareEvents(f, turned.order.orderId)).length;

  await withAdmin(f, async (h) => {
    expect((await restored(await h.restore(under.diff.id))).restored_fen).toBe(0);
    await expectRestored(f, under.diff, { adminId: h.operator.id, paid: { direct: 0n } });
    expect(await addedEvents(f, under.order.orderId, underCount)).toEqual([
      [userId, 'direct', 'forfeited', 'minor'],
    ]);
    expect(await available(f, userId)).toBe(0n);

    f.clock.set('2026-10-29T16:00:00.000Z');

    expect((await restored(await h.restore(turned.diff.id))).restored_fen).toBe(85);
    await expectRestored(f, turned.diff, { adminId: h.operator.id, paid: { direct: 85n } });
    expect(await addedEvents(f, turned.order.orderId, turnedCount)).toEqual([
      [userId, 'direct', 'active', null],
    ]);
    expect(await available(f, userId)).toBe(85n);
  });

  expect(await judged(f, under.order.orderId, userId, 'direct')).toBe(true);
  expect(await judged(f, turned.order.orderId, userId, 'direct')).toBe(false);
});

it('[AC-B2-09ga#21] D10-482「已识别」（BR-ID-26：只有已认证的实名才能识别未成年）：已认证未成年不补发；没有实名、认证失败、认证时刻晚于恢复时刻（出生日期未满 18）、已认证成年人都照常补发 85、追加 active', async () => {
  const f = await fixture(s);
  const identified = await seedCase(f);
  await identify(f, identified.userId, { birth: MINOR_BIRTH });
  const none = await seedCase(f);
  const failed = await seedCase(f);
  await identify(f, failed.userId, { status: 'failed' });
  const later = await seedCase(f);
  await identify(f, later.userId, {
    birth: MINOR_BIRTH,
    verifiedAt: new Date(f.clock.now().getTime() + 1),
  });
  const adult = await seedCase(f);
  await identify(f, adult.userId, { birth: ADULT_BIRTH });

  await withAdmin(f, async (h) => {
    expect((await restored(await h.restore(identified.diff.id))).restored_fen).toBe(0);
    expect(await available(f, identified.userId)).toBe(0n);
    for (const c of [none, failed, later, adult]) {
      const count = (await shareEvents(f, c.order.orderId)).length;
      expect((await restored(await h.restore(c.diff.id))).restored_fen).toBe(85);
      const key = restoreKey(c.order.orderKey, c.userId, 'direct', c.diff.id);
      expect(await voucherKeysOf(f, c.order)).toContain(key);
      expect(await available(f, c.userId)).toBe(85n);
      expect(await addedEvents(f, c.order.orderId, count)).toEqual([
        [c.userId, 'direct', 'active', null],
      ]);
    }
  });
});

it('[AC-B2-09ga#22] 恢复时已转 forfeited（minor）的份额之后仍按被剥夺：佣金 1000 → 600 时直推不扣不补、净额 0，本人扣 170、间推扣 17，平台 533 → 320 冲回 213，应收净额 600', async () => {
  const f = await fixture(s);
  const c = await seedCase(f);
  await identify(f, c.userId, { birth: MINOR_BIRTH });
  await withAdmin(f, async (h) => {
    expect((await restored(await h.restore(c.diff.id))).restored_fen).toBe(0);
  });
  expect(await judged(f, c.order.orderId, c.userId, 'direct')).toBe(true);
  const buyer = c.order.user('self');
  const indirect = c.order.user('indirect');

  const { result, eventId } = await partialRights(f, c.order, 600n);

  expect(result).toMatchObject({
    outcome: 'clawed_back',
    transition: 'R9',
    bookedBaseFen: 510n,
    bookedNFen: 600n,
  });
  await expectClawbacks(
    f,
    c.order,
    eventId,
    [
      [buyer, 'self', 170n],
      [indirect, 'indirect', 17n],
    ],
    213n,
  );
  const nets = await netsOf(f, c.order.orderKey);
  expect(netOf(nets, c.userId, 'direct')).toBe(0n);
  expect(nets.platform_net_fen).toBe(320n);
  expect(nets.union_receivable_net_fen).toBe(600n);
});

it('[AC-B2-09ga#23] D10-482「自购照常」的分录：未成年的 self 恢复走 ADMIN_ADJUST（RESTORE），借 COMMISSION_REVENUE 425 / 贷该受益人 available 425，键含差错单 id；之后不算被剥夺', async () => {
  const f = await fixture(s);
  const c = await seedCase(f, {
    people: [
      { role: 'self', ratioBp: 5000, forfeited: true },
      { role: 'direct', ratioBp: 1000 },
    ],
  });
  await identify(f, c.userId, { birth: MINOR_BIRTH });

  await withAdmin(f, async (h) => {
    expect((await restored(await h.restore(c.diff.id))).restored_fen).toBe(425);
    await expectRestored(f, c.diff, { adminId: h.operator.id, paid: { self: 425n } });
    const key = restoreKey(c.order.orderKey, c.userId, 'self', c.diff.id);
    expect(await voucherLines(f, key)).toEqual(restoreLines(c.userId, 425n));
  });

  expect(await judged(f, c.order.orderId, c.userId, 'self')).toBe(false);
});
