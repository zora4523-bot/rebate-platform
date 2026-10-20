import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  createSameDeviceAccountsCheck as CreateCheck,
  SameDeviceAccountsInput,
  SameDeviceFirstLogin,
} from '../../../../apps/api/src/modules/risk/application/same-device-accounts.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';

// 与既有同设备规则测试一致：通过公共出口加载，避免将 Nest 控制器编入纯 TS 测试项目。
const { createSameDeviceAccountsCheck } = (await import(
  new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url).href
)) as { createSameDeviceAccountsCheck: typeof CreateCheck };

const RULE = 'SAME_DEVICE_MULTI_ACCOUNT';
const HASH = 'a'.repeat(64);
type RewardParty = 'inviter' | 'invitee';
type Ref =
  { type: 'withdrawal'; id: string } | { type: 'invite_reward'; id: string; party: RewardParty };
let database: TestDatabase;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    if (database) await database.drop();
  }
});

async function expectInviteRewardRefConstraints(
  tables: readonly ('risk_judgements' | 'risk_hits')[] = ['risk_judgements', 'risk_hits'],
) {
  // 先断言迁移前置条件，避免后续 PG CHECK 错误被先红门禁视为非断言失败。
  for (const table of tables) {
    const { rows } = await sql<{ definition: string }>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_catalog.pg_constraint
      WHERE conrelid = ${`app.${table}`}::regclass
        AND conname = ${`${table}_ref_type_check`}
        AND contype = 'c'
    `.execute(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.definition).toContain("'invite_reward'");
  }
}

async function fixture() {
  const appId = `reward_ref_${randomUUID()}`;
  const clock = new FixedClock('2026-10-20T00:00:00Z');
  const users: string[] = [];
  for (const [index, invite] of ['ABC234', 'ABC235', 'ABC236'].entries()) {
    const id = randomUUID();
    await expect(
      sql`INSERT INTO app.users
        (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status)
        VALUES (${id}, ${appId}, 'fixture', 'fixture', ${invite},
          ${`ATTR000${index}`}, 'L1', 'sms', 'normal')`.execute(db),
    ).resolves.toMatchObject({ numAffectedRows: 1n });
    users.push(id);
  }
  // identity 登录查询不在本任务路径内；提供端口数据，真实 risk 排名及 PG 写入照常执行。
  const logins: SameDeviceFirstLogin[] = users.map((user, index) => ({
    device_hash: HASH,
    user_id: user,
    first_login_at: new Date(`2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`),
    login_log_id: BigInt(index + 1),
    status: 'normal',
    deleted_reason: null,
    merged_into_user_id: null,
  }));
  let loginReads = 0;
  let configReads = 0;
  const service = createSameDeviceAccountsCheck({
    clock,
    logger: createRootLogger(
      { level: 'silent', entry: 'api', appEnv: 'test' },
      { write: () => undefined },
    ),
    logins: {
      async read() {
        loginReads++;
        return logins;
      },
    },
    config: () => ({
      async configValue() {
        configReads++;
        return null;
      },
    }),
  });
  return {
    appId,
    users,
    clock,
    logins,
    reads: () => ({ loginReads, configReads }),
    judge(user: string, ref: Ref) {
      // 仅此边界兼容先红阶段的窄类型；port.test.ts 独立核对真实公开类型，不能靠强转过关。
      const input = { app_id: appId, user_id: user, ref };
      return service.judge(db, input as SameDeviceAccountsInput);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seedRule(f: Fixture) {
  await expect(
    db
      .insertInto('risk_rules')
      .values({
        id: randomUUID(),
        app_id: f.appId,
        rule_id: RULE,
        scene: 'withdrawal',
        conditions: {},
        risk_action: 'manual_review',
        status: 'active',
        version: 1,
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute(),
  ).resolves.toHaveLength(1);
}

function judgement(f: Fixture, refType: string, refId: string = randomUUID()) {
  return {
    app_id: f.appId,
    user_id: f.users[2]!,
    rule_id: RULE,
    ref_type: refType,
    ref_id: refId,
    marked: true,
    result: { marked: true, devices: [{ device_hash: HASH, rank: 3 }] },
    judged_at: f.clock.now(),
  };
}

function hit(f: Fixture, refType: string, refId: string = randomUUID()) {
  return {
    app_id: f.appId,
    user_id: f.users[2]!,
    rule_id: RULE,
    ref_type: refType,
    ref_id: refId,
    risk_action: 'manual_review',
    dimension: 'device',
    value_hmac: HASH,
    created_at: f.clock.now(),
  };
}

async function records(f: Fixture) {
  return {
    judgements: await db
      .selectFrom('risk_judgements')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    hits: await db
      .selectFrom('risk_hits')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

it('[AC-B1-35b#2] risk_judgements 接受邀请奖励及原三值，拒绝未知值并保留结果 CHECK', async () => {
  await expectInviteRewardRefConstraints(['risk_judgements']);
  const f = await fixture();
  await seedRule(f);
  const types = ['invite_reward', 'order', 'withdrawal', 'blocked_request'];
  for (const type of types) {
    await expect(
      db.insertInto('risk_judgements').values(judgement(f, type)).execute(),
    ).resolves.toHaveLength(1);
  }
  for (const type of ['invite_rewards', 'INVITE_REWARD', 'invite_relation', 'unknown', '']) {
    await expect(
      db.insertInto('risk_judgements').values(judgement(f, type)).execute(),
    ).rejects.toMatchObject({ code: '23514', constraint: 'risk_judgements_ref_type_check' });
  }
  await expect(
    db
      .insertInto('risk_judgements')
      .values({ ...judgement(f, 'invite_reward'), result: { marked: false } })
      .execute(),
  ).rejects.toMatchObject({ code: '23514', constraint: 'risk_judgements_result_check' });
  expect((await records(f)).judgements.map((row) => row.ref_type)).toEqual(types);
});

it('[AC-B1-35b#3] risk_hits 接受邀请奖励及原四值，拒绝未知值且不放宽 risk_action', async () => {
  await expectInviteRewardRefConstraints(['risk_hits']);
  const f = await fixture();
  await seedRule(f);
  const types = ['invite_reward', 'order', 'withdrawal', 'blocked_request', 'invite_relation'];
  for (const type of types) {
    await expect(db.insertInto('risk_hits').values(hit(f, type)).execute()).resolves.toHaveLength(
      1,
    );
  }
  for (const type of ['invite_rewards', 'INVITE_REWARD', 'unknown', '']) {
    await expect(db.insertInto('risk_hits').values(hit(f, type)).execute()).rejects.toMatchObject({
      code: '23514',
      constraint: 'risk_hits_ref_type_check',
    });
  }
  for (const action of ['pass', 'manual_review', 'block', 'void_commission']) {
    await expect(
      db
        .insertInto('risk_hits')
        .values({ ...hit(f, 'invite_reward'), risk_action: action })
        .execute(),
    ).resolves.toHaveLength(1);
  }
  await expect(
    db
      .insertInto('risk_hits')
      .values({ ...hit(f, 'invite_reward'), risk_action: 'unbind' })
      .execute(),
  ).rejects.toMatchObject({ code: '23514', constraint: 'risk_hits_risk_action_check' });
  await expect(
    sql`INSERT INTO app.risk_rules
      (id, app_id, rule_id, scene, conditions, risk_action, status, version)
      VALUES (${randomUUID()}, ${f.appId}, 'invalid_action', 'withdrawal',
        '{}'::jsonb, 'unbind', 'active', 1)`.execute(db),
  ).rejects.toMatchObject({ code: '23514', constraint: 'risk_rules_risk_action_check' });
  expect((await records(f)).hits.map((row) => row.ref_type)).toEqual([
    ...types,
    ...Array<string>(4).fill('invite_reward'),
  ]);
});

it.each([1, 2, 3])(
  '[AC-B1-35b#4] 邀请奖励判定第 %i 位账号，只标记第三位并按奖励及一方记录',
  async (rank) => {
    await expectInviteRewardRefConstraints();
    const f = await fixture();
    const user = f.users[rank - 1]!;
    const ref = randomUUID(); // invite_rewards.id 的文本；端口不负责创建或发放奖励。
    const inputRef = { type: 'invite_reward', id: ref, party: 'invitee' } as const;
    const storedRef = `${ref}:invitee`;
    const result = { marked: rank >= 3, devices: [{ device_hash: HASH, rank }] };
    await expect(f.judge(user, inputRef)).resolves.toEqual(result);
    const stored = await records(f);
    expect(stored.judgements).toEqual([
      expect.objectContaining({
        app_id: f.appId,
        user_id: user,
        rule_id: RULE,
        ref_type: 'invite_reward',
        ref_id: storedRef,
        result,
        marked: result.marked,
        judged_at: f.clock.now(),
      }),
    ]);
    expect(stored.hits).toEqual(
      rank >= 3
        ? [expect.objectContaining({ ...hit(f, 'invite_reward', storedRef), user_id: user })]
        : [],
    );
    const reads = f.reads();
    f.logins.length = 0;
    f.clock.set('2026-11-25T00:00:00Z');
    await expect(f.judge(user, inputRef)).resolves.toEqual(result);
    expect(f.reads()).toEqual(reads);
    expect(await records(f)).toEqual(stored);
  },
);

it('[AC-B1-35b#5] 邀请奖励并发与重试只判定一次，数据库唯一约束兜底两表去重', async () => {
  await expectInviteRewardRefConstraints();
  const f = await fixture();
  const ref = randomUUID();
  const inputRef = { type: 'invite_reward', id: ref, party: 'invitee' } as const;
  const storedRef = `${ref}:invitee`;
  const result = { marked: true, devices: [{ device_hash: HASH, rank: 3 }] };
  await expect(
    Promise.all([f.judge(f.users[2]!, inputRef), f.judge(f.users[2]!, inputRef)]),
  ).resolves.toEqual([result, result]);
  const before = await records(f);
  expect(before.judgements).toHaveLength(1);
  expect(before.hits).toHaveLength(1);
  expect(before.judgements[0]).toMatchObject({ ref_type: 'invite_reward', ref_id: storedRef });
  expect(before.hits[0]).toMatchObject({ ref_type: 'invite_reward', ref_id: storedRef });
  expect(f.reads().loginReads).toBe(1);
  const reads = f.reads();
  f.logins.length = 0;
  f.clock.set('2026-11-25T00:00:00Z');
  await expect(f.judge(f.users[2]!, inputRef)).resolves.toEqual(result);
  expect(f.reads()).toEqual(reads);
  expect(await records(f)).toEqual(before);
  // 绕开应用锁，证明幂等最终由 PG 约束保障。
  await expect(
    db
      .insertInto('risk_judgements')
      .values(judgement(f, 'invite_reward', storedRef))
      .execute(),
  ).rejects.toMatchObject({ code: '23505', constraint: 'risk_judgements_ref_key' });
  await expect(
    db
      .insertInto('risk_hits')
      .values(hit(f, 'invite_reward', storedRef))
      .execute(),
  ).rejects.toMatchObject({ code: '23505', constraint: 'risk_hits_same_device_once_key' });
  // 不同奖励对象必须独立判定，不能按 user_id 把奖励合并。
  await expect(
    f.judge(f.users[2]!, { type: 'invite_reward', id: randomUUID(), party: 'invitee' }),
  ).resolves.toEqual({
    marked: false,
    devices: [],
  });
  expect((await records(f)).judgements).toHaveLength(2);
});

it('[AC-B1-35b#6] 相同对象 id 的奖励与提现独立，提现命中及未命中行为保持不变', async () => {
  await expectInviteRewardRefConstraints();
  const f = await fixture();
  const ref = randomUUID();
  const inputRef = { type: 'invite_reward', id: ref, party: 'inviter' } as const;
  const marked = { marked: true, devices: [{ device_hash: HASH, rank: 3 }] };
  const clear = { marked: false, devices: [{ device_hash: HASH, rank: 1 }] };
  await expect(f.judge(f.users[2]!, inputRef)).resolves.toEqual(marked);
  const reward = await records(f);
  expect(reward.judgements).toEqual([
    expect.objectContaining({
      ref_type: 'invite_reward',
      ref_id: `${ref}:inviter`,
      result: marked,
    }),
  ]);
  expect(reward.hits).toEqual([expect.objectContaining(hit(f, 'invite_reward', `${ref}:inviter`))]);
  await expect(f.judge(f.users[0]!, { type: 'withdrawal', id: ref })).resolves.toEqual(clear);
  const withdrawal = randomUUID();
  await expect(f.judge(f.users[2]!, { type: 'withdrawal', id: withdrawal })).resolves.toEqual(
    marked,
  );
  await expect(f.judge(f.users[2]!, { type: 'withdrawal', id: withdrawal })).resolves.toEqual(
    marked,
  );
  await expect(f.judge(f.users[2]!, inputRef)).resolves.toEqual(marked);
  const stored = await records(f);
  expect(stored.judgements).toEqual([
    ...reward.judgements,
    expect.objectContaining({
      ref_type: 'withdrawal',
      ref_id: ref,
      user_id: f.users[0],
      result: clear,
    }),
    expect.objectContaining({
      ref_type: 'withdrawal',
      ref_id: withdrawal,
      user_id: f.users[2],
      result: marked,
    }),
  ]);
  expect(stored.hits).toEqual([
    ...reward.hits,
    expect.objectContaining(hit(f, 'withdrawal', withdrawal)),
  ]);
});

it('[AC-B1-35b#7] 相同奖励 ref 在不同 app_id 分别持久化判定与命中', async () => {
  await expectInviteRewardRefConstraints();
  const first = await fixture();
  const second = await fixture();
  const ref = randomUUID();
  const result = { marked: true, devices: [{ device_hash: HASH, rank: 3 }] };
  for (const f of [first, second]) {
    await expect(
      f.judge(f.users[2]!, { type: 'invite_reward', id: ref, party: 'invitee' }),
    ).resolves.toEqual(result);
    const stored = await records(f);
    expect(stored.judgements).toEqual([
      expect.objectContaining({
        app_id: f.appId,
        user_id: f.users[2],
        ref_type: 'invite_reward',
        ref_id: `${ref}:invitee`,
        result,
      }),
    ]);
    expect(stored.hits).toEqual([
      expect.objectContaining(hit(f, 'invite_reward', `${ref}:invitee`)),
    ]);
  }
});

it.each([
  { firstParty: 'inviter', secondParty: 'invitee' },
  { firstParty: 'invitee', secondParty: 'inviter' },
] as const)(
  '[AC-B1-35b#8] 同一奖励先判 $firstParty 排名一，再判 $secondParty 排名三，双方分别记录和回放',
  async ({ firstParty, secondParty }) => {
    await expectInviteRewardRefConstraints();
    const f = await fixture();
    const rewardId = randomUUID();
    const firstRef = { type: 'invite_reward', id: rewardId, party: firstParty } as const;
    const secondRef = { type: 'invite_reward', id: rewardId, party: secondParty } as const;
    const clear = { marked: false, devices: [{ device_hash: HASH, rank: 1 }] };
    const marked = { marked: true, devices: [{ device_hash: HASH, rank: 3 }] };

    await expect(f.judge(f.users[0]!, firstRef)).resolves.toEqual(clear);
    await expect(f.judge(f.users[2]!, secondRef)).resolves.toEqual(marked);
    const stored = await records(f);
    expect(stored.judgements).toEqual([
      expect.objectContaining({
        app_id: f.appId,
        rule_id: RULE,
        user_id: f.users[0],
        ref_type: 'invite_reward',
        ref_id: `${rewardId}:${firstParty}`,
        marked: false,
        result: clear,
        judged_at: f.clock.now(),
      }),
      expect.objectContaining({
        app_id: f.appId,
        rule_id: RULE,
        user_id: f.users[2],
        ref_type: 'invite_reward',
        ref_id: `${rewardId}:${secondParty}`,
        marked: true,
        result: marked,
        judged_at: f.clock.now(),
      }),
    ]);
    // 精确一条命中：排名一的一方没有命中，排名三的一方持有自己的命中。
    expect(stored.hits).toEqual([
      expect.objectContaining(hit(f, 'invite_reward', `${rewardId}:${secondParty}`)),
    ]);
    expect(f.reads().loginReads).toBe(2);
    const reads = f.reads();
    f.logins.length = 0;
    f.clock.set('2026-11-25T00:00:00Z');
    await expect(f.judge(f.users[0]!, firstRef)).resolves.toEqual(clear);
    await expect(f.judge(f.users[2]!, secondRef)).resolves.toEqual(marked);
    expect(f.reads()).toEqual(reads);
    expect(await records(f)).toEqual(stored);
  },
);
