import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ABORT, RULE, databaseFixture, seedBlock, seedUser, setup, state } from './kit.ts';

const database = databaseFixture();

it.each([
  { dimension: 'order_no_suffix', value: '012345', action: 'manual_review', attributed: false },
  { dimension: 'order_no_suffix', value: '012345', action: 'void_commission', attributed: true },
  { dimension: 'channel', value: 'R8', action: 'manual_review', attributed: true },
  { dimension: 'channel', value: 'R8', action: 'void_commission', attributed: false },
] as const)(
  '[AC-B1-09a#15] $dimension / $action 命中惰性登记规则，保存订单引用、可空用户和名单值 HMAC',
  async ({ dimension, value, action, attributed }) => {
    const db = database();
    const f = setup(db);
    const user = attributed ? await seedUser(db, f.app) : null;
    await seedBlock(db, f, { dimension, value });
    const before = await state(db, f.app);
    expect(before.rules).toEqual([]);
    const input = { ...f.hitInput, user_id: user, dimension, value, risk_action: action };
    await db.transaction().execute((trx) => f.ports.recordHit(trx, input));
    const stored = await state(db, f.app);
    expect(stored.blocks).toEqual(before.blocks);
    expect(stored.rules).toHaveLength(1);
    expect(stored.rules[0]).toMatchObject({
      app_id: f.app,
      rule_id: RULE,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    });
    expect(stored.hits).toEqual([
      expect.objectContaining({
        app_id: f.app,
        user_id: user,
        rule_id: RULE,
        risk_action: action,
        dimension,
        value_hmac: f.crypto.blindIndex(value, `blocklist.${dimension}`),
        ref_type: 'order',
        ref_id: input.order_id,
        created_at: f.clock.now(),
        request_type: null,
        related_phone_hmac: null,
        related_phone_masked: null,
        amount_fen: null,
      }),
    ]);
    expect(stored.hits[0]!.value_hmac).not.toBe(value);
  },
);

it('[AC-B1-09a#16] 已有 BLACKLIST_HIT 配置原样保留，写入使用调用方指定的处置', async () => {
  const db = database();
  const f = setup(db);
  await db
    .insertInto('risk_rules')
    .values({
      id: randomUUID(),
      app_id: f.app,
      rule_id: RULE,
      scene: 'order',
      conditions: { operator_setting: true },
      risk_action: 'block',
      status: 'inactive',
      version: 17,
      row_version: 4,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  const before = await state(db, f.app);
  f.clock.set('2026-12-01T00:00:00Z');
  await db.transaction().execute((trx) => f.ports.recordHit(trx, f.hitInput));
  const after = await state(db, f.app);
  expect(after.rules).toEqual(before.rules);
  expect(after.hits).toHaveLength(1);
  expect(after.hits[0]).toMatchObject({ risk_action: 'manual_review', created_at: f.clock.now() });
});

it('[AC-B1-09a#17] 同一订单先 manual_review 后 void_commission 各留一行，首次命中不被改写', async () => {
  const db = database();
  const f = setup(db);
  const user = await seedUser(db, f.app);
  await db.transaction().execute((trx) => f.ports.recordHit(trx, f.hitInput));
  const before = await state(db, f.app);
  expect(before.hits).toHaveLength(1);
  f.clock.set('2026-12-01T00:00:00Z');
  await db.transaction().execute((trx) =>
    f.ports.recordHit(trx, {
      ...f.hitInput,
      user_id: user,
      risk_action: 'void_commission',
    }),
  );
  // D10-293：只追加，改判作废插第二行，第一行原样保留。
  const after = await state(db, f.app);
  expect(after.blocks).toEqual(before.blocks);
  expect(after.rules).toEqual(before.rules);
  expect(after.hits).toHaveLength(2);
  expect(after.hits.map((row) => row.risk_action).sort()).toEqual([
    'manual_review',
    'void_commission',
  ]);
  const first = before.hits[0]!;
  expect(after.hits.find((row) => row.id === first.id)).toEqual(first);
  expect(after.hits.find((row) => row.id !== first.id)).toMatchObject({
    app_id: f.app,
    user_id: user,
    rule_id: RULE,
    risk_action: 'void_commission',
    value_hmac: first.value_hmac,
    ref_type: 'order',
    ref_id: f.hitInput.order_id,
    created_at: f.clock.now(),
  });
});

it('[AC-B1-09a#18] 并发首次命中规则惰性登记无冲突，同键去重、不同值分别留痕', async () => {
  const db = database();
  const f = setup(db);
  await Promise.all(
    ['R8', 'R8', 'R9', 'R9'].map((value) =>
      db.transaction().execute((trx) => f.ports.recordHit(trx, { ...f.hitInput, value })),
    ),
  );
  const stored = await state(db, f.app);
  expect(stored.rules).toHaveLength(1);
  expect(stored.hits).toHaveLength(2);
  expect(stored.hits.map((row) => row.value_hmac).sort()).toEqual(
    ['R8', 'R9'].map((value) => f.crypto.blindIndex(value, 'blocklist.channel')).sort(),
  );
  expect(stored.hits.every((row) => row.ref_id === f.hitInput.order_id)).toBe(true);
});

it('[AC-B1-09a#19] 同值的不同订单、不同 app 分别记录；HMAC 来自名单值而非订单号', async () => {
  const db = database();
  const f = setup(db);
  const otherApp = `${f.app}_other`;
  const otherOrder = randomUUID();
  for (const [app, order] of [
    [f.app, f.hitInput.order_id],
    [f.app, otherOrder],
    [otherApp, f.hitInput.order_id],
  ]) {
    await db.transaction().execute((trx) =>
      f.ports.recordHit(trx, {
        ...f.hitInput,
        app_id: app!,
        order_id: order!,
      }),
    );
  }
  const first = await state(db, f.app);
  const second = await state(db, otherApp);
  expect(first.rules).toHaveLength(1);
  expect(second.rules).toHaveLength(1);
  expect(first.hits.map((row) => row.ref_id).sort()).toEqual(
    [f.hitInput.order_id, otherOrder].sort(),
  );
  expect(second.hits).toHaveLength(1);
  expect(second.hits[0]).toMatchObject({ app_id: otherApp, ref_id: f.hitInput.order_id });
  expect(new Set([...first.hits, ...second.hits].map((row) => row.value_hmac))).toEqual(
    new Set([f.crypto.blindIndex('R8', 'blocklist.channel')]),
  );
});

it('[AC-B1-09a#20] 调用方回滚时规则和命中同时消失，之后可成功重试', async () => {
  const db = database();
  const f = setup(db);
  await expect(
    db.transaction().execute(async (trx) => {
      await f.ports.recordHit(trx, f.hitInput);
      expect(
        await trx.selectFrom('risk_rules').selectAll().where('app_id', '=', f.app).execute(),
      ).toHaveLength(1);
      expect(
        await trx.selectFrom('risk_hits').selectAll().where('app_id', '=', f.app).execute(),
      ).toHaveLength(1);
      // 独立连接不应看见尚未提交的写入。
      expect(await state(db, f.app)).toEqual({ blocks: [], hits: [], rules: [] });
      throw ABORT;
    }),
  ).rejects.toBe(ABORT);
  expect(await state(db, f.app)).toEqual({ blocks: [], hits: [], rules: [] });
  await db.transaction().execute((trx) => f.ports.recordHit(trx, f.hitInput));
  const stored = await state(db, f.app);
  expect(stored.rules).toHaveLength(1);
  expect(stored.hits).toHaveLength(1);
});
