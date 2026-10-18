import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CODE,
  DOMAIN,
  PRIVATE_NAME,
  answer,
  client,
  risk,
  seed,
  shareDomains,
  success,
  unavailable,
  verified,
  withHttp,
  type Fixture,
} from './kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let redis: Awaited<ReturnType<typeof acquireTestRedis>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  redis = await acquireTestRedis();
}, 180_000);
afterAll(async () => {
  try {
    await redis?.stop();
  } finally {
    try {
      if (db) await destroyDb(db);
    } finally {
      await database?.drop();
    }
  }
});
// Construct the real AppModule inside each case, so missing implementation remains a case
// failure rather than an unexecuted suite. Expected data never comes from production helpers.
const http = (run: (f: Fixture) => Promise<void>) => withHttp(db, redis.url, run);

it('[AC-B1-11j#1] 已实名成年人：真实无签名入口返回契约全部五字段，去掉 planned', async () => {
  await http(async (f) => {
    const user = await seed(f, { code: CODE });
    await verified(f, user, '1980-01-01');
    const c = await client(f, user);
    success(f, await c.get());
    expect(f.operation.operationId).toBe('getMyInvite');
    expect(f.operation['x-implementation']).toBeUndefined();
    expect(f.operation['x-auth']).toBe('phone');
    expect(f.operation['x-signed']).toBe(false);
  });
});

for (const state of ['banned', 'appealing', 'frozen'] as const) {
  it(`[AC-B1-11j#2] 本人 ${state}：200 隐藏邀请码、链接、海报，仍返回人数且不透露原因`, async () => {
    await http(async (f) => {
      const user = await seed(f, { code: CODE });
      await risk(f, user, state);
      await seed(f, { parent: user.uid });
      await seed(f, { parent: user.uid, status: 'deleted' });
      const c = await client(f, user);
      unavailable(f, await c.get(), 1);
    });
  });
}

it('[AC-B1-11j#3] 本人 status=deleted：保留有效会话种子验证 unavailable，人数照常', async () => {
  await http(async (f) => {
    const user = await seed(f, { code: CODE, status: 'deleted' });
    await seed(f, { parent: user.uid });
    const c = await client(f, user);
    unavailable(f, await c.get(), 1);
  });
});

for (const state of ['normal', 'frozen', 'banned', 'appealing'] as const) {
  it(`[AC-B1-11j#4] 已实名未满 18 且 ${state}：30413 self_minor 优先于不可邀请的 200`, async () => {
    await http(async (f) => {
      const user = await seed(f, { code: CODE });
      await verified(f, user, '2010-06-01');
      await risk(f, user, state);
      const c = await client(f, user);
      const response = await c.get();
      expect(answer(f, response, 30413).data).toEqual({ reason: 'self_minor' });
      for (const secret of [PRIVATE_NAME, '2010-06-01', `fixture-${user.uid}`]) {
        expect(response.body + f.lines.join('\n')).not.toContain(secret);
      }
    });
  });
}

for (const status of ['absent', 'none', 'failed'] as const) {
  it(`[AC-B1-11j#5] 实名状态 ${status} 无 verified 生日：按成年处理，不要求实名`, async () => {
    await http(async (f) => {
      const user = await seed(f, { code: CODE });
      if (status !== 'absent') {
        await f.db
          .insertInto('realname')
          .values({
            id: randomUUID(),
            app_id: f.appId,
            user_id: user.uid,
            status,
          })
          .execute();
      }
      const c = await client(f, user);
      success(f, await c.get());
    });
  });
}

// BR-ID-26: the birthday's following 00:00 +08:00, including the non-leap-year Feb 29 rule.
// Literal expected instants deliberately do not call reachedAgeAt / isAtLeastAge.
for (const [birth, birthday, before, reached] of [
  [
    '2008-09-30',
    '2026-09-29T16:00:00.000Z',
    '2026-09-30T15:59:59.999Z',
    '2026-09-30T16:00:00.000Z',
  ],
  [
    '2008-02-29',
    '2026-02-28T16:00:00.000Z',
    '2026-03-01T15:59:59.999Z',
    '2026-03-01T16:00:00.000Z',
  ],
] as const) {
  it(`[AC-B1-11j#6] ${birth} 出生：生日当天仍未满，满 18 时刻前 1ms 拒绝、恰到时刻恢复`, async () => {
    await http(async (f) => {
      f.clock.set(birthday);
      const user = await seed(f, { code: CODE });
      await verified(f, user, birth);
      await seed(f, { parent: user.uid });
      const c = await client(f, user);
      expect(answer(f, await c.get(), 30413).data).toEqual({ reason: 'self_minor' });
      f.clock.set(before);
      expect(answer(f, await c.get({ 'x-clock': reached }), 30413).data).toEqual({
        reason: 'self_minor',
      });
      f.clock.set(reached);
      success(f, await c.get({ 'x-clock': before }), CODE, 1);
    });
  });
}

it('[AC-B1-11j#7] 请求间新识别未成年：立即从可邀请变为 30413，不缓存实名结果', async () => {
  await http(async (f) => {
    const user = await seed(f, { code: CODE });
    const c = await client(f, user);
    success(f, await c.get());
    await verified(f, user, '2010-06-01');
    expect(answer(f, await c.get(), 30413).data).toEqual({ reason: 'self_minor' });
  });
});

for (const minor of [false, true]) {
  it(`[AC-B1-11j#8] 未绑手机且已识别未成年=${minor}：10005 优先于 30413 与 200`, async () => {
    await http(async (f) => {
      const user = await seed(f, { code: CODE, phone: false });
      if (minor) await verified(f, user, '2010-06-01');
      const c = await client(f, user);
      expect(answer(f, await c.get(), 10005).code).toBe(10005);
    });
  });
}

it('[AC-B1-11j#9] direct_count 实时统计直属未注销用户：计入封禁冻结，排除孙级与别人的下级', async () => {
  await http(async (f) => {
    const user = await seed(f, { code: CODE });
    const child = await seed(f, { parent: user.uid });
    const banned = await seed(f, { parent: user.uid });
    const frozen = await seed(f, { parent: user.uid });
    await risk(f, banned, 'banned');
    await risk(f, frozen, 'frozen');
    await seed(f, { parent: user.uid, status: 'deleted' });
    await seed(f, { parent: child.uid });
    const other = await seed(f);
    await seed(f, { parent: other.uid });
    // TODO(规划/11 §2.3): 注销 cooling/processing 真实注销单仍计入 — blocked on B1-15
    // Until then, the stipulated representation is status<>'deleted'; do not invent a table.
    const c = await client(f, user);
    const first = await c.get();
    success(f, first, CODE, 3);
    expect(first.body).not.toContain(child.uid);
    expect(first.body).not.toContain('私密昵称');
    expect(first.body).not.toContain('private.example.test');
    const added = await seed(f, { parent: user.uid });
    success(f, await c.get(), CODE, 4);
    await f.db
      .updateTable('users')
      .set({ status: 'deleted', row_version: sql`row_version + 1` })
      .where('id', '=', added.uid)
      .where('app_id', '=', f.appId)
      .execute();
    success(f, await c.get(), CODE, 3);
    await risk(f, user, 'frozen');
    unavailable(f, await c.get(), 3);
  });
});

it('[AC-B1-11j#10] 风险按请求时状态读取：冻结立即关闭邀请，解除后恢复', async () => {
  await http(async (f) => {
    const user = await seed(f, { code: CODE });
    const c = await client(f, user);
    success(f, await c.get());
    await risk(f, user, 'frozen');
    unavailable(f, await c.get(), 0);
    await risk(f, user, 'normal');
    success(f, await c.get());
  });
});

for (const [label, value] of [
  ['缺失', undefined],
  ['空数组', []],
  ['null', null],
  ['非数组', DOMAIN],
  ['首项非字符串', [42, DOMAIN]],
  ['首项空串', ['', DOMAIN]],
  ['带协议', ['https://share.example.test', DOMAIN]],
  ['带路径', ['share.example.test/path', DOMAIN]],
  ['带用户信息', ['user@share.example.test', DOMAIN]],
  ['带查询参数', ['share.example.test?uid=private', DOMAIN]],
  ['带空格', ['bad domain.test', DOMAIN]],
] as const) {
  it(`[AC-B1-11j#11] share_domains ${label}：仍可邀请但 landing_url=null，不取第二项并记录无个人信息告警`, async () => {
    await http(async (f) => {
      const user = await seed(f, { code: CODE });
      if (value === undefined) {
        // couli_app may UPDATE config_items but cannot DELETE. Move the seeded key
        // within this case's unique app_id so share_domains is genuinely absent.
        await f.db
          .updateTable('config_items')
          .set({ key: 'fixture.absent_share_domains' })
          .where('app_id', '=', f.appId)
          .where('key', '=', 'share_domains')
          .execute();
      } else {
        await shareDomains(f, value);
      }
      const c = await client(f, user);
      const start = f.lines.length;
      success(f, await c.get(), CODE, 0, null);
      const warnings = f.lines
        .slice(start)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.level === 40 && line.config_key === 'share_domains');
      expect(warnings.length).toBeGreaterThan(0);
      for (const warning of warnings) {
        // Pino's normal metadata is allowed; the only business field is config_key.
        const keys = Object.keys(warning).filter(
          (key) =>
            !['level', 'time', 'pid', 'hostname', 'msg', 'entry', 'env', 'config_key'].includes(
              key,
            ),
        );
        expect(keys).toEqual([]);
        expect(JSON.stringify(warning)).not.toContain(user.uid);
        expect(JSON.stringify(warning)).not.toContain('私密昵称');
      }
    });
  });
}

it('[AC-B1-11j#12] 域名取当前首项，切换后立即生效，链接只有域名与邀请码', async () => {
  await http(async (f) => {
    const user = await seed(f, { code: CODE });
    const c = await client(f, user);
    success(f, await c.get());
    await shareDomains(f, ['new-share.example.test', DOMAIN]);
    success(f, await c.get(), CODE, 0, 'new-share.example.test');
  });
});

it('[AC-B1-11j#13] 同码跨 app：本人、实名、风险、域名与直属人数均不串租户', async () => {
  await http(async (f) => {
    const user = await seed(f, { code: CODE });
    const other = await seed(f, { code: CODE, appId: `${f.appId}_other` });
    await shareDomains(f, ['other.example.test'], other.appId);
    await verified(f, other, '2010-06-01');
    await risk(f, other, 'frozen');
    await seed(f, { parent: other.uid, appId: other.appId });
    await seed(f, { parent: other.uid, appId: other.appId });
    await seed(f, { parent: user.uid });
    const c = await client(f, user);
    success(f, await c.get(), CODE, 1);
    const otherClient = await client(f, other);
    expect(answer(f, await otherClient.get(), 30413).data).toEqual({ reason: 'self_minor' });
  });
});
