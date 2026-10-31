// B1-03ze: POST /admin/v1/appeals/{appeal_id}/claim (adminClaimAppeal; CT-24r, 编排裁定 D10-158).
// A mark, not a lock: on a processing appeal whose row_version is expected_row_version, handler_id
// becomes the caller, claimed_at the server's time and row_version + 1 (also for the current
// handler, also when another account claims it again). No longer processing, or another
// row_version → 20902 resource=appeal, nothing changed. Unknown / foreign appeal_id → 20001.
// Audit appeal_claim with the handler before and after. claimed_at is observed through the detail
// only (the column is this task's migration).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  CONFLICT,
  UNKNOWN,
  appealOf,
  appealRow,
  auditsOf,
  colleague,
  instants,
  iso,
  noPersonalData,
  refused,
  resolvedEvents,
  riskRow,
  seed,
  setup,
  snapshot,
} from './kit.ts';

const h = useHarness();

it.each(['banned', 'order', 'register'] as const)(
  '[AC-B1-03ze#30] 认领 %s：处理人为调用者、claimed_at 为服务端当前时间、版本 +1，仍处理中；写审计',
  async (kind) => {
    const s = await setup(h, { displayName: '客服小林' });
    const { row, user } = await seed(s, kind);
    const riskBefore = user === null ? undefined : await riskRow(s, user.id);
    s.f.clock.advanceMs(60_000);
    const now = s.f.clock.now().toISOString();
    const d = await appealOf(await s.claim(row.id, { expected_row_version: 0 }));
    expect(d).toMatchObject({
      appeal_id: row.id,
      status: 'processing',
      handler_id: s.a.id,
      handler_name: '客服小林',
      closed_at: null,
      row_version: 1,
    });
    expect(d.claimed_at === null ? null : iso(d.claimed_at)).toBe(now);
    // The detail read afterwards answers the same appeal.
    expect(instants(await appealOf(await s.detail(row.id)))).toEqual(instants(d));
    expect(await appealRow(s, row.id)).toMatchObject({
      status: 'processing',
      handler_id: s.a.id,
      closed_at: null,
      row_version: 1,
    });
    // A claim changes no risk state and queues no appeal.resolved.
    if (user !== null) expect(await riskRow(s, user.id)).toEqual(riskBefore);
    expect(await resolvedEvents(s)).toEqual([]);
    const audits = await auditsOf(s, 'appeal_claim');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ app_id: s.appId, admin_id: s.a.id });
    expect(String(audits[0]!.target)).toContain(row.id);
    expect(JSON.stringify(audits[0]!.after)).toContain(s.a.id);
    noPersonalData(audits, [user?.phone ?? null, user?.hmac ?? null]);
  },
);

it('[AC-B1-03ze#31] 不独占：另一账号再认领改写处理人与 claimed_at；审计记前后处理人', async () => {
  const s = await setup(h);
  const other = await colleague(s, { displayName: '风控小王' });
  const { row } = await seed(s, 'frozen');
  await appealOf(await s.claim(row.id, { expected_row_version: 0 }));
  s.f.clock.advanceMs(5 * 60_000);
  const later = s.f.clock.now().toISOString();
  const d = await appealOf(await other.claim(row.id, { expected_row_version: 1 }));
  expect(d).toMatchObject({
    handler_id: other.a.id,
    handler_name: '风控小王',
    status: 'processing',
    row_version: 2,
  });
  expect(iso(d.claimed_at!)).toBe(later);
  expect(await appealRow(s, row.id)).toMatchObject({ handler_id: other.a.id, row_version: 2 });
  const audits = await auditsOf(s, 'appeal_claim');
  expect(audits.map((a) => a.admin_id)).toEqual([s.a.id, other.a.id]);
  expect(JSON.stringify(audits[1]!.before)).toContain(s.a.id);
  expect(JSON.stringify(audits[1]!.after)).toContain(other.a.id);
});

it('[AC-B1-03ze#32] 当前处理人再次认领同样版本 +1、claimed_at 更新', async () => {
  const s = await setup(h);
  const { row } = await seed(s, 'rule');
  await appealOf(await s.claim(row.id, { expected_row_version: 0 }));
  s.f.clock.advanceMs(60_000);
  const d = await appealOf(await s.claim(row.id, { expected_row_version: 1 }));
  expect(d).toMatchObject({ handler_id: s.a.id, row_version: 2 });
  expect(iso(d.claimed_at!)).toBe(s.f.clock.now().toISOString());
  expect(await auditsOf(s, 'appeal_claim')).toHaveLength(2);
});

it('[AC-B1-03ze#33] 版本不符 → 20902 resource=appeal，什么都不改', async () => {
  const s = await setup(h);
  const { row } = await seed(s, 'banned', { row_version: 4 });
  const before = await snapshot(s);
  for (const expected_row_version of [0, 3, 5]) {
    await refused(await s.claim(row.id, { expected_row_version }), 20902, CONFLICT);
  }
  expect(await snapshot(s)).toEqual(before);
  expect((await appealOf(await s.detail(row.id))).claimed_at).toBeNull();
});

it.each(['upheld', 'revoked'] as const)(
  '[AC-B1-03ze#34] 已结案（%s）不能认领 → 20902，什么都不改',
  async (status) => {
    const s = await setup(h);
    const { row } = await seed(s, 'order', { status });
    const before = await snapshot(s);
    await refused(
      await s.claim(row.id, { expected_row_version: row.row_version }),
      20902,
      CONFLICT,
    );
    expect(await snapshot(s)).toEqual(before);
  },
);

it('[AC-B1-03ze#35] 未知、非 UUID 与别的应用的 appeal_id → 20001 [appeal_id]，身份头不能换应用', async () => {
  const s = await setup(h);
  const other = await setup(h);
  const { row: foreign } = await seed(other, 'banned');
  const before = await snapshot(other);
  for (const id of [randomUUID(), 'not-an-appeal-id', foreign.id]) {
    await refused(
      await s.claim(id, { expected_row_version: 0 }, { 'x-app-id': other.appId }),
      20001,
      UNKNOWN,
    );
  }
  expect(await snapshot(other)).toEqual(before);
  expect(await auditsOf(s, 'appeal_claim')).toEqual([]);
});

it.each<[string, unknown]>([
  ['缺失', {}],
  ['负数', { expected_row_version: -1 }],
  ['小数', { expected_row_version: 1.5 }],
  ['字符串', { expected_row_version: '0' }],
  ['null', { expected_row_version: null }],
])('[AC-B1-03ze#36] expected_row_version %s → 20001，什么都不改', async (_label, body) => {
  const s = await setup(h);
  const { row } = await seed(s, 'order');
  const before = await snapshot(s);
  await refused(await s.claim(row.id, body), 20001, { fields: ['expected_row_version'] });
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03ze#37] 同一认领重放（带同一 Idempotency-Key 也一样）只生效一次：第二次 20902', async () => {
  const s = await setup(h);
  const { row } = await seed(s, 'order');
  const key = { 'idempotency-key': randomUUID() };
  await appealOf(await s.claim(row.id, { expected_row_version: 0 }, key));
  const after = await snapshot(s);
  await refused(await s.claim(row.id, { expected_row_version: 0 }, key), 20902, CONFLICT);
  await refused(await s.claim(row.id, { expected_row_version: 0 }), 20902, CONFLICT);
  expect(await snapshot(s)).toEqual(after);
  expect(await auditsOf(s, 'appeal_claim')).toHaveLength(1);
});

it('[AC-B1-03ze#38] 两个账号以同一版本并发认领：恰好一个成功，另一个 20902', async () => {
  const s = await setup(h);
  const other = await colleague(s);
  const { row } = await seed(s, 'banned');
  const answers = await Promise.all([
    s.claim(row.id, { expected_row_version: 0 }),
    other.claim(row.id, { expected_row_version: 0 }),
  ]);
  const codes = answers.map((r) => r.json().code).sort((a, b) => a - b);
  expect(codes).toEqual([0, 20902]);
  const winner = answers.findIndex((r) => r.json().code === 0);
  const loser = answers[1 - winner]!;
  await refused(loser, 20902, CONFLICT);
  const d = await appealOf(answers[winner]!);
  expect(d.row_version).toBe(1);
  expect(await appealRow(s, row.id)).toMatchObject({
    row_version: 1,
    handler_id: winner === 0 ? s.a.id : other.a.id,
  });
  expect(await auditsOf(s, 'appeal_claim')).toHaveLength(1);
});
