import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture as smsFixture } from '../../identity/sms-login/kit.ts';
import {
  closeKit,
  DEDUPE,
  expectMarked,
  H,
  hits,
  J,
  LIMIT,
  localMerge,
  login,
  merge,
  openKit,
  RULE,
  seedUser,
  setup,
  snapshot,
  trio,
  WINDOW,
  type Kit,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

it('[AC-B1-03k#1] 第三个及以后账号打标，前两个不受影响，重复登录只算一个账号', async () => {
  const f = setup(kit);
  const { a, b, c } = await trio(f);
  await f.login(a, H, '2026-09-02T00:00:00Z');
  await f.login(a, H, '2026-09-03T00:00:00Z');
  for (const user of [a, b]) expect((await f.judge(user)).marked).toBe(false);
  expect(await hits(kit.db, f.appId)).toEqual([]);
  await expectMarked(f, c);
  expect(await hits(kit.db, f.appId)).toHaveLength(1);
  const d = await f.user();
  await f.login(d, H, '2026-09-21T00:00:00Z');
  await expectMarked(f, d, H, 4);
  expect((await hits(kit.db, f.appId)).map((row) => row.user_id).sort()).toEqual([c, d].sort());
});

it('[AC-B1-03k#2] 下界前 1ms 的登录不计入', async () => {
  const f = setup(kit);
  const a = await f.user();
  const b = await f.user();
  const c = await f.user();
  await f.login(a, H, new Date(f.clock.now().getTime() - WINDOW - 1));
  await f.login(b, H, '2026-09-10T00:00:00Z');
  await f.login(c, H, '2026-09-20T00:00:00Z');
  expect((await f.judge(c)).marked).toBe(false);
  expect(await hits(kit.db, f.appId)).toEqual([]);
});

it('[AC-B1-03k#2] BR 示例：9月25日标记，10月15日重判不沿用过期排名', async () => {
  const f = setup(kit);
  const { c } = await trio(f);
  await expectMarked(f, c);
  f.clock.set('2026-10-15T00:00:00Z');
  expect((await f.judge(c)).marked).toBe(false);
  expect(await hits(kit.db, f.appId)).toHaveLength(1);
});

it('[AC-B1-03k#3] 720 小时下界与 now 都计入，窗口不是按自然日取整', async () => {
  const f = setup(kit);
  f.clock.set('2026-09-25T13:42:07.321Z');
  const a = await f.user();
  const b = await f.user();
  const c = await f.user();
  await f.login(a, H, new Date(f.clock.now().getTime() - WINDOW));
  await f.login(b, H, '2026-09-10T00:00:00Z');
  await f.login(c, H, f.clock.now());
  await expectMarked(f, c);
  expect(await hits(kit.db, f.appId)).toHaveLength(1);
});

it('[AC-B1-03k#3] 晚于 now 1ms 的本人登录不能取得参与设备', async () => {
  const f = setup(kit);
  const a = await f.user();
  const b = await f.user();
  const c = await f.user();
  await f.login(a, H, '2026-09-01T00:00:00Z');
  await f.login(b, H, '2026-09-10T00:00:00Z');
  await f.login(c, H, new Date(f.clock.now().getTime() + 1));
  expect((await f.judge(c)).marked).toBe(false);
  expect(await hits(kit.db, f.appId)).toEqual([]);
});

it('[AC-B1-03k#4] 排序取窗口内首次，而不是历史首次或窗口内末次', async () => {
  const f = setup(kit);
  const a = await f.user();
  const b = await f.user();
  const c = await f.user();
  await f.login(c, H, '2026-08-01T00:00:00Z');
  // Insert out of timestamp order to distinguish log ID order from the primary time key.
  await f.login(c, H, '2026-09-20T00:00:00Z');
  await f.login(b, H, '2026-09-10T00:00:00Z');
  await f.login(a, H, '2026-09-01T00:00:00Z');
  await f.login(a, H, '2026-09-24T00:00:00Z');
  await expectMarked(f, c);
  expect((await f.judge(a)).marked).toBe(false);
});

it('[AC-B1-03k#4] 同时刻按 login_logs.id 升序，不按 user_id 或返回顺序', async () => {
  const f = setup(kit);
  const users = [await f.user(), await f.user(), await f.user()].sort().reverse();
  const ids: bigint[] = [];
  for (const user of users) ids.push(await f.login(user, H, '2026-09-10T00:00:00Z'));
  expect(ids[0]! < ids[1]! && ids[1]! < ids[2]!).toBe(true);
  await expectMarked(f, users[2]!);
  expect((await f.judge(users[0]!)).marked).toBe(false);
  expect((await f.judge(users[1]!)).marked).toBe(false);
});

it.each([undefined, true])(
  '[AC-B1-03k#5] 默认或显式开启去重 %s：原地并号只算目标账号一个',
  async (value) => {
    const f = setup(kit);
    if (value !== undefined) f.values.set(DEDUPE, value);
    const { c } = await localMerge(kit, f);
    expect((await f.judge(c)).marked).toBe(false);
    expect(await hits(kit.db, f.appId)).toEqual([]);
  },
);

it('[AC-B1-03k#5] 跨设备并号：目标未在 H 登录仍计源；目标登录 H 后承接源时刻', async () => {
  const f = setup(kit);
  const a = await f.user();
  const b = await f.user();
  const c = await f.user();
  const z = await f.user();
  await f.login(a, H, '2026-09-01T00:00:00Z');
  await f.login(b, H, '2026-09-02T00:00:00Z');
  await f.login(c, H, '2026-09-03T00:00:00Z');
  await merge(kit, f, b, z);
  await f.login(z, J, '2026-09-05T00:00:00Z', { method: 'merge' });
  await expectMarked(f, c);
  await f.login(z, H, '2026-09-12T00:00:00Z');
  await expectMarked(f, c);
  expect((await f.judge(z)).marked).toBe(false);
  expect(await hits(kit.db, f.appId)).toHaveLength(2);
});

it.each(['2026-08-01T00:00:00Z', '2026-09-25T00:00:00.001Z'])(
  '[AC-B1-03k#5] 目标在 H 的登录 %s 不在同一窗口时不得去重',
  async (targetAt) => {
    const f = setup(kit);
    const { b, c } = await trio(f);
    const z = await f.user();
    await merge(kit, f, b, z);
    await f.login(z, H, targetAt);
    await expectMarked(f, c);
    expect(await hits(kit.db, f.appId)).toHaveLength(1);
  },
);

it('[AC-B1-03k#5] 同一次判断每台设备分别去重，H 有目标记录不免除 J 上的源', async () => {
  const f = setup(kit);
  const { a, b, c } = await localMerge(kit, f);
  const z = await f.user();
  await f.login(z, J, '2026-09-01T00:00:00Z');
  await f.login(b, J, '2026-09-05T00:00:00Z');
  await f.login(c, J, '2026-09-10T00:00:00Z');
  expect((await f.judge(a)).marked).toBe(false);
  await expectMarked(f, c, J);
  expect((await hits(kit.db, f.appId)).map((row) => row.value_hmac)).toEqual([J]);
});

it('[AC-B1-03k#5] 承接后并列沿用源记录的 id，而不是目标的较晚 id', async () => {
  const f = setup(kit);
  const a = await f.user();
  const b = await f.user();
  const c = await f.user();
  const z = await f.user();
  await f.login(a, H, '2026-09-01T00:00:00Z');
  const sourceId = await f.login(b, H, '2026-09-10T00:00:00Z');
  const cId = await f.login(c, H, '2026-09-10T00:00:00Z');
  const targetId = await f.login(z, H, '2026-09-10T00:00:00Z', { method: 'merge' });
  await merge(kit, f, b, z);
  expect(sourceId < cId && cId < targetId).toBe(true);
  await expectMarked(f, c);
  expect((await f.judge(z)).marked).toBe(false);
});

it('[AC-B1-03k#5] 窗口外源登录不得承接；多个源并入同一目标只算一个', async () => {
  const f = setup(kit);
  const a = await f.user();
  const b = await f.user();
  const c = await f.user();
  const z = await f.user();
  await f.login(b, H, '2026-08-01T00:00:00Z');
  await f.login(a, H, '2026-09-01T00:00:00Z');
  await f.login(c, H, '2026-09-10T00:00:00Z');
  await f.login(z, H, '2026-09-20T00:00:00Z');
  await merge(kit, f, b, z);
  await expectMarked(f, z);
  const d = await f.user();
  await f.login(b, H, '2026-09-02T00:00:00Z');
  await f.login(d, H, '2026-09-03T00:00:00Z');
  await merge(kit, f, d, z, '2026-09-05T00:00:00Z', 'merged', 'deleted', 'apple');
  await expectMarked(f, c, H, 3);
  expect((await f.judge(z)).marked).toBe(false);
});

it.each([
  { status: 'deleted', reason: 'cancelled' },
  { status: 'normal', reason: 'merged' },
])('[AC-B1-03k#5] 墓碑去重必须同时满足 deleted 和 merged：%j', async ({ status, reason }) => {
  const f = setup(kit);
  const { a, b, c } = await trio(f);
  await merge(kit, f, b, a, '2026-09-12T00:00:00Z', reason, status);
  await expectMarked(f, c);
  expect(await hits(kit.db, f.appId)).toHaveLength(1);
});

it('[AC-B1-03k#6] 关闭去重时原地并号墓碑仍占名次', async () => {
  const f = setup(kit);
  f.values.set(DEDUPE, false);
  const { c } = await localMerge(kit, f);
  await expectMarked(f, c);
  expect(await hits(kit.db, f.appId)).toHaveLength(1);
});

it('[AC-B1-03k#6] 关闭去重时不把源的排序时刻转给目标', async () => {
  const f = setup(kit);
  f.values.set(DEDUPE, false);
  const { b, c } = await trio(f);
  const z = await f.user();
  await merge(kit, f, b, z);
  await f.login(z, H, '2026-09-24T00:00:00Z');
  await expectMarked(f, c, H, 3);
  await expectMarked(f, z, H, 4);
  expect(await hits(kit.db, f.appId)).toHaveLength(2);
});

it.each([
  { limit: 1, subject: 'a', marked: true, rank: 1 },
  { limit: 2, subject: 'b', marked: true, rank: 2 },
  { limit: 4, subject: 'c', marked: false, rank: 3 },
  { limit: Number.MAX_SAFE_INTEGER, subject: 'c', marked: false, rank: 3 },
] as const)('[AC-B1-03k#7] 有效正整数阈值 %j', async ({ limit, subject, marked, rank }) => {
  const f = setup(kit);
  f.values.set(LIMIT, limit);
  const users = await trio(f);
  const result = await f.judge(users[subject]);
  expect(result.marked).toBe(marked);
  if (marked) expect(result.devices).toContainEqual({ device_hash: H, rank });
  expect(await hits(kit.db, f.appId)).toHaveLength(marked ? 1 : 0);
});

it.each(
  ['3', 0, -1, 1.5, true, null, {}, [], Number.MAX_SAFE_INTEGER + 1].map((value) => ({ value })),
)('[AC-B1-03k#7] limit 坏值 %j 回 3 并打 warn', async ({ value }) => {
  const f = setup(kit);
  f.values.set(LIMIT, value);
  const { b, c } = await trio(f);
  expect((await f.judge(b)).marked).toBe(false);
  await expectMarked(f, c);
  expect(
    f.lines.map((line) => JSON.parse(line) as { level: number }).some((line) => line.level === 40),
  ).toBe(true);
});

it.each(['false', 'true', 0, 1, null, {}, []].map((value) => ({ value })))(
  '[AC-B1-03k#7] dedupe 非 JSON 布尔 %j 回 on',
  async ({ value }) => {
    const f = setup(kit);
    f.values.set(DEDUPE, value);
    const { c } = await localMerge(kit, f);
    expect((await f.judge(c)).marked).toBe(false);
    expect(await hits(kit.db, f.appId)).toEqual([]);
  },
);

it('[AC-B1-03k#7] 配置读取失败分别回 limit=3 与 dedupe=on', async () => {
  const f = setup(kit);
  f.failures.add(LIMIT);
  f.failures.add(DEDUPE);
  const { b, c } = await trio(f);
  expect((await f.judge(b)).marked).toBe(false);
  await expectMarked(f, c);
  const other = setup(kit);
  other.failures.add(DEDUPE);
  const local = await localMerge(kit, other);
  expect((await other.judge(local.c)).marked).toBe(false);
  expect(await hits(kit.db, other.appId)).toEqual([]);
});

it('[AC-B1-03k#8] 两台命中设备各一行；逐列记录本人、规则、设备原值、提现单和 Clock 时刻', async () => {
  const f = setup(kit);
  const { a, b, c } = await trio(f);
  for (const [user, at] of [
    [a, '2026-09-01'],
    [b, '2026-09-02'],
    [c, '2026-09-03'],
  ] as const) {
    await f.login(user, J, `${at}T00:00:00Z`);
  }
  const ref = randomUUID();
  const result = await f.judge(c, ref);
  expect(result.marked).toBe(true);
  expect([...result.devices].sort((x, y) => x.device_hash.localeCompare(y.device_hash))).toEqual([
    { device_hash: H, rank: 3 },
    { device_hash: J, rank: 3 },
  ]);
  const rows = await hits(kit.db, f.appId);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.value_hmac).sort()).toEqual([H, J]);
  for (const row of rows) {
    expect(row).toMatchObject({
      app_id: f.appId,
      user_id: c,
      rule_id: RULE,
      risk_action: 'manual_review',
      dimension: 'device',
      ref_type: 'withdrawal',
      ref_id: ref,
      created_at: f.clock.now(),
      request_type: null,
      related_phone_hmac: null,
      related_phone_masked: null,
      amount_fen: null,
    });
  }
  const rules = await kit.db
    .withSchema('app')
    .selectFrom('risk_rules')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('rule_id', '=', RULE)
    .execute();
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ app_id: f.appId, rule_id: RULE, risk_action: 'manual_review' });
});

it('[AC-B1-03k#9] 同一 device_hash 在其他 app 的账号不计，本人未登录的设备不参与', async () => {
  const f = setup(kit);
  const foreign = setup(kit);
  await trio(foreign);
  const a = await f.user();
  const b = await f.user();
  const c = await f.user();
  await f.login(a, H, '2026-09-01T00:00:00Z');
  await f.login(c, H, '2026-09-20T00:00:00Z');
  await f.login(a, J, '2026-09-01T00:00:00Z');
  await f.login(b, J, '2026-09-02T00:00:00Z');
  const d = await f.user();
  await f.login(d, J, '2026-09-03T00:00:00Z');
  expect((await f.judge(c)).marked).toBe(false);
  expect(await hits(kit.db, f.appId)).toEqual([]);
  expect(await hits(kit.db, foreign.appId)).toEqual([]);
});

it('[AC-B1-03k#10] 同一提现单重复与并发判断只有一组行，另一个提现单各记一组', async () => {
  const f = setup(kit);
  const { a, b, c } = await trio(f);
  await f.login(a, J, '2026-09-01T00:00:00Z');
  await f.login(b, J, '2026-09-02T00:00:00Z');
  await f.login(c, J, '2026-09-03T00:00:00Z');
  const ref = randomUUID();
  const first = await f.judge(c, ref);
  expect(first.marked).toBe(true);
  expect(await f.judge(c, ref)).toEqual(first);
  expect(await hits(kit.db, f.appId)).toHaveLength(2);
  // Fresh reference tests insert races, not just concurrent reads of pre-existing hits.
  const concurrentRef = randomUUID();
  const concurrent = await Promise.all([
    kit.db.transaction().execute((trx) => f.judge(c, concurrentRef, trx)),
    kit.db.transaction().execute((trx) => f.judge(c, concurrentRef, trx)),
  ]);
  expect(concurrent).toEqual([first, first]);
  const rows = await hits(kit.db, f.appId);
  expect(rows).toHaveLength(4);
  for (const id of [ref, concurrentRef]) {
    expect(
      rows
        .filter((row) => row.ref_id === id)
        .map((row) => row.value_hmac)
        .sort(),
    ).toEqual([H, J]);
  }
});

it('[AC-B1-03k#11] 判定前后 users、已有 user_risk_state 与有效 sessions 完全不变', async () => {
  const f = setup(kit);
  const { a, b, c } = await trio(f);
  const device = randomUUID();
  await sql`INSERT INTO app.devices
    (id, app_id, device_hash, id_source, install_secret_cipher, platform, app_version, last_seen_at)
    VALUES (${device}, ${f.appId}, ${H}, 'idfv', ${Buffer.from('fixture')},
      'ios', '2.0.0', ${f.clock.now()})`.execute(kit.db);
  for (const user of [a, b, c]) {
    await sql`INSERT INTO app.sessions (id, app_id, sid, user_id, device_id, created_at, updated_at)
      VALUES (${randomUUID()}, ${f.appId}, ${randomUUID()}, ${user}, ${device},
        ${f.clock.now()}, ${f.clock.now()})`.execute(kit.db);
    await sql`INSERT INTO app.user_risk_state
      (user_id, app_id, state, changed_by, changed_at, created_at, updated_at)
      VALUES (${user}, ${f.appId}, 'normal', 'fixture', ${f.clock.now()},
        ${f.clock.now()}, ${f.clock.now()})`.execute(kit.db);
  }
  const before = await snapshot(kit.db, f.appId);
  expect(before.users).toHaveLength(3);
  expect(before.risk).toHaveLength(3);
  expect(before.sessions).toHaveLength(3);
  await expectMarked(f, c);
  expect((await f.judge(a)).marked).toBe(false);
  expect((await f.judge(b)).marked).toBe(false);
  expect(await snapshot(kit.db, f.appId)).toEqual(before);
});

it('[AC-B1-03k#8] 配置、未提交登录与命中行均使用传入事务，回滚不留下风险命中', async () => {
  const f = setup(kit);
  const rollback = new Error('fixture rollback');
  const ref = randomUUID();
  await expect(
    kit.db.transaction().execute(async (trx) => {
      const a = await seedUser(trx, f.appId);
      const b = await seedUser(trx, f.appId);
      const c = await seedUser(trx, f.appId);
      await login(trx, f.appId, a, H, '2026-09-01T00:00:00Z');
      await login(trx, f.appId, b, H, '2026-09-02T00:00:00Z');
      await login(trx, f.appId, c, H, '2026-09-03T00:00:00Z');
      expect((await f.judge(c, ref, trx)).marked).toBe(true);
      expect(await hits(trx, f.appId)).toHaveLength(1);
      for (const key of [LIMIT, DEDUPE]) {
        expect(f.reads.some((read) => read.key === key && read.app === f.appId)).toBe(true);
      }
      expect(f.reads.every((read) => read.handle === trx)).toBe(true);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await hits(kit.db, f.appId)).toEqual([]);
});

it('[AC-B1-03k#1] 空 device_hash 不计；判定依据 device_hash 而非 device_id_hash', async () => {
  const f = setup(kit);
  const a = await f.user();
  const b = await f.user();
  const c = await f.user();
  const legacy = await f.user();
  await f.login(legacy, null, '2026-09-01T00:00:00Z', { deviceIdHash: H });
  await f.login(a, H, '2026-09-02T00:00:00Z', { deviceIdHash: H });
  await f.login(b, J, '2026-09-03T00:00:00Z', { deviceIdHash: H });
  await f.login(c, H, '2026-09-04T00:00:00Z', { deviceIdHash: H });
  expect((await f.judge(c)).marked).toBe(false);
  expect((await f.judge(legacy)).marked).toBe(false);
  expect(await hits(kit.db, f.appId)).toEqual([]);
  await f.login(b, H, '2026-09-03T00:00:00Z', { deviceIdHash: J });
  await expectMarked(f, c);
});

it.each(['sms', 'wechat', 'apple', 'huawei', 'merge'])(
  '[AC-B1-03k#1] 成功登录记录不按 method 过滤：%s',
  async (method) => {
    const f = setup(kit);
    const a = await f.user();
    const b = await f.user();
    const c = await f.user();
    await f.login(a, H, '2026-09-01T00:00:00Z', { method });
    await f.login(b, H, '2026-09-02T00:00:00Z', { method });
    await f.login(c, H, '2026-09-03T00:00:00Z', { method });
    await expectMarked(f, c);
    expect(await hits(kit.db, f.appId)).toHaveLength(1);
  },
);

it('[AC-B1-03k#1] identity 成功登录保存本次设备行的 device_hash，随后可被 risk 查询判定', async () => {
  const f = setup(kit);
  const sms = await smsFixture(kit);
  f.clock.set(sms.clock.now());
  const a = await seedUser(kit.db, sms.appId);
  const b = await seedUser(kit.db, sms.appId);
  const c = await sms.account();
  await login(kit.db, sms.appId, a, sms.hash, new Date(f.clock.now().getTime() - 2000));
  await login(kit.db, sms.appId, b, sms.hash, new Date(f.clock.now().getTime() - 1000));
  expect((await sms.login()).code).toBe(0);
  const logs = await sql<{ device_hash: string; device_id_hash: string }>`
    SELECT device_hash, device_id_hash FROM app.login_logs
    WHERE app_id = ${sms.appId} AND user_id = ${c}`.execute(kit.db);
  expect(logs.rows).toHaveLength(1);
  expect(logs.rows[0]!.device_hash).toBe(sms.hash);
  expect(logs.rows[0]!.device_hash).not.toBe(logs.rows[0]!.device_id_hash);
  const result = await f.service.judge(kit.db, {
    app_id: sms.appId,
    user_id: c,
    ref: { type: 'withdrawal', id: randomUUID() },
  });
  expect(result.marked).toBe(true);
  expect(result.devices).toContainEqual({ device_hash: sms.hash, rank: 3 });
  expect(await hits(kit.db, sms.appId)).toHaveLength(1);
});

it('[AC-B1-03k#9][AC-B1-03k#10] app_id 不同但设备和提现单号相同，命中记录分别保留', async () => {
  const ref = randomUUID();
  const apps = [setup(kit), setup(kit)];
  for (const f of apps) {
    const { c } = await trio(f);
    expect((await f.judge(c, ref)).marked).toBe(true);
    const rows = await hits(kit.db, f.appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ app_id: f.appId, user_id: c, ref_id: ref, value_hmac: H });
  }
});

it('[AC-B1-03k#1] 没有成功登录记录的账号不标记，也不产生风险状态', async () => {
  const f = setup(kit);
  await trio(f);
  const user = await f.user();
  expect((await f.judge(user)).marked).toBe(false);
  expect(await hits(kit.db, f.appId)).toEqual([]);
  expect((await snapshot(kit.db, f.appId)).risk).toEqual([]);
});
