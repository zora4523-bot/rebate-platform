import { expect, it } from 'vitest';
import {
  ABORT,
  RULE,
  databaseFixture,
  expectEscalationIndex,
  seedUser,
  setup,
  state,
  type Action,
} from './kit.ts';

const database = databaseFixture();
const ACTIONS: readonly Action[] = ['manual_review', 'void_commission'];

it.each([
  { first: 'manual_review', then: 'void_commission' },
  { first: 'void_commission', then: 'manual_review' },
] as const)(
  '[AC-B1-09ab#5] 同一订单先 $first 后 $then：只追加第二行，第一行一字不改',
  async ({ first, then }) => {
    const db = database();
    await expectEscalationIndex(db);
    const f = setup(db);
    const user = await seedUser(db, f.app);
    // 首次命中时订单尚未归属用户；改判时调用方带上用户。
    await db
      .transaction()
      .execute((trx) => f.ports.recordHit(trx, { ...f.hitInput, risk_action: first }));
    const before = await state(db, f.app);
    expect(before.hits).toHaveLength(1);
    f.clock.set('2026-12-01T00:00:00Z');
    await db
      .transaction()
      .execute((trx) =>
        f.ports.recordHit(trx, { ...f.hitInput, user_id: user, risk_action: then }),
      );
    const after = await state(db, f.app);
    expect(after.rules).toEqual(before.rules);
    expect(after.blocks).toEqual(before.blocks);
    expect(after.hits).toHaveLength(2);
    expect(after.hits[0]).toEqual(before.hits[0]);
    expect(after.hits[0]).toMatchObject({ risk_action: first, user_id: null });
    expect(after.hits[1]).toMatchObject({
      app_id: f.app,
      user_id: user,
      rule_id: RULE,
      risk_action: then,
      dimension: f.hitInput.dimension,
      value_hmac: before.hits[0]!.value_hmac,
      ref_type: 'order',
      ref_id: f.hitInput.order_id,
      created_at: f.clock.now(),
      request_type: null,
      related_phone_hmac: null,
      related_phone_masked: null,
      amount_fen: null,
    });
  },
);

it.each(ACTIONS)(
  '[AC-B1-09ab#6] 同一订单同值同处置 %s 重复记录仍只一条，换用户或时钟不覆盖',
  async (action) => {
    const db = database();
    await expectEscalationIndex(db);
    const f = setup(db);
    const user = await seedUser(db, f.app);
    const input = { ...f.hitInput, risk_action: action };
    await db.transaction().execute((trx) => f.ports.recordHit(trx, input));
    const before = await state(db, f.app);
    expect(before.hits).toEqual([
      expect.objectContaining({ risk_action: action, user_id: null, created_at: f.clock.now() }),
    ]);
    f.clock.set('2026-12-01T00:00:00Z');
    await db.transaction().execute((trx) => f.ports.recordHit(trx, input));
    await db.transaction().execute((trx) => f.ports.recordHit(trx, { ...input, user_id: user }));
    expect(await state(db, f.app)).toEqual(before);
  },
);

it('[AC-B1-09ab#7] 反复改判只留每种处置的首次记录：交替记录（含同一事务内）后同一订单恰好两行', async () => {
  const db = database();
  await expectEscalationIndex(db);
  const f = setup(db);
  const firstAt = f.clock.now();
  await db.transaction().execute((trx) => f.ports.recordHit(trx, f.hitInput));
  f.clock.set('2026-12-01T00:00:00Z');
  const escalatedAt = f.clock.now();
  await db.transaction().execute(async (trx) => {
    for (const risk_action of ['void_commission', 'manual_review', 'void_commission'] as const) {
      await f.ports.recordHit(trx, { ...f.hitInput, risk_action });
    }
  });
  f.clock.set('2026-12-02T00:00:00Z');
  for (const risk_action of ACTIONS) {
    await db.transaction().execute((trx) => f.ports.recordHit(trx, { ...f.hitInput, risk_action }));
  }
  const stored = await state(db, f.app);
  expect(stored.rules).toHaveLength(1);
  const rows = stored.hits.map((row) => [row.risk_action, row.created_at, row.ref_id]);
  expect(rows).toEqual([
    ['manual_review', firstAt, f.hitInput.order_id],
    ['void_commission', escalatedAt, f.hitInput.order_id],
  ]);
});

it('[AC-B1-09ab#8] 并发记录两种处置：规则惰性登记一次，同一订单每种处置各一行', async () => {
  const db = database();
  await expectEscalationIndex(db);
  const f = setup(db);
  await Promise.all(
    [...ACTIONS, ...ACTIONS].map((risk_action) =>
      db.transaction().execute((trx) => f.ports.recordHit(trx, { ...f.hitInput, risk_action })),
    ),
  );
  const stored = await state(db, f.app);
  expect(stored.rules).toHaveLength(1);
  expect(stored.hits).toHaveLength(2);
  expect(stored.hits.map((row) => row.risk_action).sort()).toEqual([...ACTIONS]);
  expect(stored.hits.every((row) => row.ref_id === f.hitInput.order_id)).toBe(true);
});

it('[AC-B1-09ab#9] 处置之外的键不变：同一订单不同名单值、不同订单各自按处置去重', async () => {
  const db = database();
  await expectEscalationIndex(db);
  const f = setup(db);
  const cases = [
    { order_id: f.hitInput.order_id, value: 'R8' },
    { order_id: f.hitInput.order_id, value: 'R9' },
    { order_id: `${f.hitInput.order_id}-other`, value: 'R8' },
  ];
  const expected: string[] = [];
  for (const { order_id, value } of cases) {
    const hmac = f.crypto.blindIndex(value, 'blocklist.channel');
    for (const risk_action of ACTIONS) expected.push(`${order_id}|${hmac}|${risk_action}`);
  }
  for (let round = 0; round < 2; round++) {
    for (const { order_id, value } of cases) {
      for (const risk_action of ACTIONS) {
        const input = { ...f.hitInput, order_id, value, risk_action };
        await db.transaction().execute((trx) => f.ports.recordHit(trx, input));
      }
    }
  }
  const stored = await state(db, f.app);
  const keys = stored.hits.map((row) => `${row.ref_id}|${row.value_hmac}|${row.risk_action}`);
  expect(keys.sort()).toEqual(expected.sort());
});

it('[AC-B1-09ab#10] 改判作废随调用方回滚时不留第二行、首行不变；之后重试再追加', async () => {
  const db = database();
  await expectEscalationIndex(db);
  const f = setup(db);
  await db.transaction().execute((trx) => f.ports.recordHit(trx, f.hitInput));
  const before = await state(db, f.app);
  expect(before.hits).toHaveLength(1);
  const escalate = { ...f.hitInput, risk_action: 'void_commission' as const };
  f.clock.set('2026-12-01T00:00:00Z');
  await expect(
    db.transaction().execute(async (trx) => {
      await f.ports.recordHit(trx, escalate);
      const inside = await trx
        .selectFrom('risk_hits')
        .select('risk_action')
        .where('app_id', '=', f.app)
        .orderBy('id')
        .execute();
      expect(inside).toEqual([
        { risk_action: 'manual_review' },
        { risk_action: 'void_commission' },
      ]);
      throw ABORT;
    }),
  ).rejects.toBe(ABORT);
  expect(await state(db, f.app)).toEqual(before);
  await db.transaction().execute((trx) => f.ports.recordHit(trx, escalate));
  const after = await state(db, f.app);
  expect(after.hits).toHaveLength(2);
  expect(after.hits[0]).toEqual(before.hits[0]);
  expect(after.hits[1]).toMatchObject({
    risk_action: 'void_commission',
    ref_id: f.hitInput.order_id,
    created_at: f.clock.now(),
  });
});
