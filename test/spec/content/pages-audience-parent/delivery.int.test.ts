// 03 §6.1, BR-INV-11 / BR-INV-23 and F1-09j §9.2: real AppModule and contract-checked HTTP.
import { createDb, destroyDb } from '@couli/db';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createPageAudienceFacts } from '../../../../apps/api/src/modules/content/application/page-audience.ts';
import { harness, session, type Harness } from '../config/kit.ts';
import { binding, order } from '../pages-audience/kit.ts';
import { seedPage } from '../pages-read/kit.ts';
import { assembledReads } from './assembly-kit.ts';
import { audiencePage, bindParent, hasEquality, queryProbe, visible } from './kit.ts';

let database: Awaited<ReturnType<(typeof import('@couli/db/testing'))['createTestDatabase']>>;
let redis: Awaited<ReturnType<(typeof import('@couli/db/testing'))['acquireTestRedis']>>;
let db: ReturnType<typeof createDb>;
let h: Harness;
beforeAll(async () => {
  const testing = await import('@couli/db/testing');
  database = await testing.createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  redis = await testing.acquireTestRedis();
  h = await harness(db, database.urlFor('couli_app'), redis.url);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
});

const WITHOUT_PARENT = ['public', 'any', 'has_parent_no', 'union_no', 'order_no'];
const WITH_PARENT = ['public', 'any', 'has_parent_yes', 'union_no', 'order_no'];

it.each([
  { ac: 1, parent: false, expected: WITHOUT_PARENT },
  { ac: 2, parent: true, expected: WITH_PARENT },
])(
  '[AC-F1-09j#$ac] 登录用户 parent=$parent 按当前关系下发 yes/no，any 均命中',
  async ({ parent, expected }) => {
    const subject = await audiencePage(h);
    if (parent) await bindParent(h, subject);
    const probe = queryProbe();
    const app = await h.start('api', db.withPlugin(probe.plugin));
    expect(await visible(app, subject)).toEqual(expected);
    expect(probe.queries.filter((query) => query.fact === 'parent')).toHaveLength(1);
  },
);

it('[AC-F1-09j#3] 同设备游客不查事实，登录后读上级，退出为游客不沿用登录事实', async () => {
  const subject = await audiencePage(h);
  await bindParent(h, subject);
  await binding(h, subject, 'taobao', 'active');
  await order(h, subject, 'PAID', 'ESTIMATED');
  const probe = queryProbe();
  const app = await h.start('api', db.withPlugin(probe.plugin));
  expect(await visible(app, subject, true)).toEqual(WITHOUT_PARENT);
  expect(probe.queries).toHaveLength(0);
  expect(await visible(app, subject)).toEqual([
    'public',
    'any',
    'has_parent_yes',
    'union_yes',
    'order_yes',
    'both',
  ]);
  expect(probe.queries.filter((query) => query.fact === 'parent')).toHaveLength(1);
  probe.queries.length = 0;
  expect(await visible(app, subject, true)).toEqual(WITHOUT_PARENT);
  expect(probe.queries).toHaveLength(0);
});

it('[AC-F1-09j#4] 其他应用和同应用其他用户有上级均不串用，查询限定 app_id 和 id', async () => {
  const subject = await audiencePage(h);
  const login = await session(h, subject.id, subject.device);
  const otherUser = {
    ...subject,
    userId: login.user.id,
    headers: { ...subject.guest, ...login.headers },
  };
  const otherApp = await audiencePage(h);
  await bindParent(h, otherUser);
  await bindParent(h, otherApp);
  const probe = queryProbe();
  const app = await h.start('api', db.withPlugin(probe.plugin));
  // users.id is a global PK: a duplicate id in two apps is not a valid fixture. Check the
  // actual WHERE predicates as well. A foreign-app subject cannot pass HTTP authentication,
  // so exercise that pair through the same production read factory with the real database.
  const logger = { warn: vi.fn() };
  const facts = createPageAudienceFacts({ reads: await assembledReads(db), logger });
  expect(await facts.facts(subject.id, otherApp.userId, new Set(['hasParent']))).toEqual({
    hasParent: false,
    unionAuthorized: null,
    hasOrder: null,
  });
  expect((await facts.facts(otherApp.id, otherApp.userId, new Set(['hasParent']))).hasParent).toBe(
    true,
  );
  expect((await facts.facts(subject.id, otherApp.userId, new Set(['hasParent']))).hasParent).toBe(
    false,
  );
  expect(logger.warn).not.toHaveBeenCalled();
  for (const [person, expected] of [
    [subject, WITHOUT_PARENT],
    [otherUser, WITH_PARENT],
    [otherApp, WITH_PARENT],
    [subject, WITHOUT_PARENT],
  ] as const) {
    probe.queries.length = 0;
    expect(await visible(app, person)).toEqual(expected);
    const reads = probe.queries.filter((query) => query.fact === 'parent');
    expect(reads).toHaveLength(1);
    expect(hasEquality(reads[0]!.node, 'app_id', person.id)).toBe(true);
    expect(hasEquality(reads[0]!.node, 'id', person.userId)).toBe(true);
  }
});

it('[AC-F1-09j#5] 页面缓存 60 秒内绑定上级，下一请求立即改为 yes，事实每请求只查一次', async () => {
  const subject = await audiencePage(h);
  const probe = queryProbe();
  const app = await h.start('api', db.withPlugin(probe.plugin));
  const before = h.deps.clock.now().getTime();
  expect(await visible(app, subject)).toEqual(WITHOUT_PARENT);
  expect(probe.queries.filter((query) => query.fact === 'parent')).toHaveLength(1);
  await bindParent(h, subject);
  probe.queries.length = 0;
  expect(await visible(app, subject)).toEqual(WITH_PARENT);
  expect(probe.queries.filter((query) => query.fact === 'parent')).toHaveLength(1);
  probe.queries.length = 0;
  expect(await visible(app, subject)).toEqual(WITH_PARENT);
  expect(probe.queries.filter((query) => query.fact === 'parent')).toHaveLength(1);
  expect(h.deps.clock.now().getTime()).toBe(before);
});

it('[AC-F1-09j#6] has_parent 与 union_authorized 组合条件四种事实组合只有双 yes 命中', async () => {
  for (const parent of [false, true]) {
    for (const authorized of [false, true]) {
      const subject = await audiencePage(h);
      if (parent) await bindParent(h, subject);
      if (authorized) await binding(h, subject, 'pdd', 'active');
      expect
        .soft(await visible(h.app, subject))
        .toEqual([
          'public',
          'any',
          parent ? 'has_parent_yes' : 'has_parent_no',
          authorized ? 'union_yes' : 'union_no',
          'order_no',
          ...(parent && authorized ? ['both'] : []),
        ]);
    }
  }
});

it('[AC-F1-09j#7] 同一登录用户访问无条件或仅 any 的页面不查上级，条件页面才查', async () => {
  const subject = await audiencePage(h);
  await bindParent(h, subject);
  await seedPage(h, subject.id, {
    key: 'custom:plain',
    versions: [{ number: 1, sections: [{ id: 'plain' }] }],
  });
  await seedPage(h, subject.id, {
    key: 'custom:any',
    versions: [{ number: 1, sections: [{ id: 'any', condition: { has_parent: 'any' } }] }],
  });
  const probe = queryProbe();
  const app = await h.start('api', db.withPlugin(probe.plugin));
  for (const key of ['plain', 'any']) {
    expect(await visible(app, subject, false, `custom:${key}`)).toEqual([key]);
    expect(probe.queries).toHaveLength(0);
  }
  expect(await visible(app, subject)).toEqual(WITH_PARENT);
  expect(probe.queries.filter((query) => query.fact === 'parent')).toHaveLength(1);
  probe.queries.length = 0;
  expect(await visible(app, subject, false, 'custom:any')).toEqual(['any']);
  expect(probe.queries).toHaveLength(0);
});

it('[AC-F1-09j#8] 上级读取失败整页仍 200，仅该事实未知且 warn 一次，下次请求恢复', async () => {
  const subject = await audiencePage(h);
  await bindParent(h, subject);
  await binding(h, subject, 'taobao', 'active');
  await order(h, subject, 'PAID', 'ESTIMATED');
  const probe = queryProbe();
  probe.control.failParent = true;
  const app = await h.start('api', db.withPlugin(probe.plugin));
  const start = h.logs.length;
  expect(await visible(app, subject)).toEqual(['public', 'any', 'union_yes', 'order_yes']);
  const warnings = h.logs
    .slice(start)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['event'] === 'content_page_audience_unavailable');
  expect(warnings).toEqual([
    expect.objectContaining({
      level: 40,
      app_id: subject.id,
      fact: 'has_parent',
      err: 'synthetic parent read unavailable',
    }),
  ]);
  expect(probe.queries.filter((query) => query.fact === 'parent')).toHaveLength(1);
  probe.control.failParent = false;
  probe.queries.length = 0;
  expect(await visible(app, subject)).toEqual([
    'public',
    'any',
    'has_parent_yes',
    'union_yes',
    'order_yes',
    'both',
  ]);
  expect(probe.queries.filter((query) => query.fact === 'parent')).toHaveLength(1);
});
