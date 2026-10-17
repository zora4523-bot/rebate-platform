// Scope: F1-09e brief §9 (SPEC_REF 038229e), CT-02l and previewPage contracts.
// All cases exercise registered HTTP routes; only the orchestrator's container runs this file.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { KyselyPlugin } from 'kysely';
import { expect, it, vi } from 'vitest';
import { factory, useHarness, type HttpApp } from '../../admin/auth/kit.ts';
import { guardOf } from '../../admin/guard-mount/kit.ts';
import {
  ACTION,
  ISSUE,
  PREVIEW,
  SECTIONS,
  appId,
  assertRoute,
  audits,
  contentSnapshot,
  hash,
  issue,
  issued,
  member,
  previewed,
  publishPointers,
  read,
  rejected,
  seedVersion,
  setup,
  snapshot,
  tokenRow,
  tokenRows,
  userBearer,
} from './kit.ts';

const h = useHarness();

it('[AC-F1-09e#1] 只持 content.page 即可签发，无 step-up，守卫使用写模式', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  const run = vi.spyOn(await guardOf(f.app), 'run');
  try {
    const result = await issued(await issue(f, 1));
    expect(result).toMatchObject({ page_key: 'home', version: 1 });
    expect(Object.keys(result).sort()).toEqual(['expire_at', 'page_key', 'token', 'version']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].permission).toBe('content.page');
    expect(run.mock.calls[0]![0].readOnly ?? false).toBe(false);
  } finally {
    run.mockRestore();
  }
});

it('[AC-F1-09e#2] 两次签发产生不同的 32 字节随机 token，只存 SHA256，时间同源且恰为十分钟', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  // Deliberately differs from wall time and includes milliseconds (no SQL now/default).
  f.clock.advanceMs(123);
  const now = f.clock.now().getTime();
  const first = await issued(await issue(f, 1));
  const second = await issued(await issue(f, 1));
  expect(first.token).not.toBe(second.token);
  expect(await tokenRows(h, f.appId)).toHaveLength(2);
  for (const result of [first, second]) {
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(result.token, 'base64url')).toHaveLength(32);
    const row = await tokenRow(h, f, result.token);
    expect(row).toMatchObject({
      token_hash: hash(result.token),
      app_id: f.appId,
      page_key: 'home',
      version: 1,
      created_by: f.actor.id,
      used_count: 0,
    });
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(result.token);
    expect(row.created_at.getTime()).toBe(now);
    expect(row.expire_at.getTime() - row.created_at.getTime()).toBe(600_000);
    expect(Date.parse(result.expire_at)).toBe(row.expire_at.getTime());
  }
  expect(f.lines.join('\n')).not.toContain(first.token);
  expect(f.lines.join('\n')).not.toContain(second.token);
});

it.each(['draft', 'published', 'rolled_back'] as const)(
  '[AC-F1-09e#3] %s 版本都能签发并预览',
  async (status) => {
    const f = await setup(h);
    await seedVersion(h, f, 7, status, 'custom:preview-test');
    const result = await issued(await issue(f, 7, 'custom:preview-test'));
    expect(await previewed(await read(f, result.token, 'custom:preview-test'))).toEqual({
      page_key: 'custom:preview-test',
      version: 7,
      sections: SECTIONS,
    });
  },
);

it('[AC-F1-09e#4] 未知页 30701；已存页缺少版本 20001 fields=[version]；拒绝均无写入', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  const before = await snapshot(h, f);
  await rejected(await issue(f, 1, 'custom:missing'), 'issue', 30701);
  const missingVersion = await issue(f, 2);
  await rejected(missingVersion, 'issue', 20001);
  expect(missingVersion.response.json()).toMatchObject({ data: { fields: ['version'] } });
  expect(await snapshot(h, f)).toEqual(before);
});

it('[AC-F1-09e#5] 无权限或只有其他 content 权限返回 10403，不写 token、页面或审计', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  for (const points of [[], ['content.platform_icon']]) {
    const token = await member(h, f, points);
    const before = await snapshot(h, f);
    await rejected(await issue(f, 1, 'home', token), 'issue', 10403);
    expect(await snapshot(h, f)).toEqual(before);
  }
});

it('[AC-F1-09e#6] 签发需要后台身份，未认证请求 10001 且无业务写入', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  const before = await snapshot(h, f);
  await rejected(await issue(f, 1, 'home', null), 'issue', 10001);
  expect(await snapshot(h, f)).toEqual(before);
});

it('[AC-F1-09e#7] app_id 只来自后台 actor，伪造 X-App-Id 不改变签发归属', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  const foreignId = appId();
  const foreign = { ...f, appId: foreignId };
  await seedVersion(h, foreign, 1, 'draft', 'home', [{ id: 'foreign' }]);
  const foreignBefore = await snapshot(h, foreign);
  const result = await issued(await issue(f, 1, 'home', f.token, { 'x-app-id': foreignId }));
  expect(await tokenRow(h, f, result.token)).toMatchObject({ app_id: f.appId });
  expect(await previewed(await read(f, result.token))).toMatchObject({ sections: SECTIONS });
  expect(await snapshot(h, foreign)).toEqual(foreignBefore);
  // A version which exists only in the other app cannot be signed by this actor.
  await seedVersion(h, foreign, 9);
  const missing = await issue(f, 9);
  await rejected(missing, 'issue', 20001);
  expect(missing.response.json()).toMatchObject({ data: { fields: ['version'] } });
});

it('[AC-F1-09e#8] 签发恰写一条审计，记录 actor 与版本和到期时间，不含明文或哈希', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  const before = await audits(h, f.appId);
  const at = f.clock.now().getTime();
  const result = await issued(await issue(f, 1));
  const ids = new Set(before.map((row) => row.id));
  const added = (await audits(h, f.appId)).filter((row) => !ids.has(row.id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    app_id: f.appId,
    admin_id: f.actor.id,
    action: ACTION,
    after: { page_key: 'home', version: 1, expire_at: result.expire_at },
  });
  expect(added[0]!.at.getTime()).toBe(at);
  expect(added[0]!.target).toEqual(expect.any(String));
  expect(added[0]!.target).toContain('home');
  const text = JSON.stringify({
    target: added[0]!.target,
    before: added[0]!.before,
    after: added[0]!.after,
  });
  expect(text).not.toContain(result.token);
  expect(text).not.toContain(hash(result.token));
});

it('[AC-F1-09e#9] 游客低版本仍读钉住的草稿全部 sections，无灰度或人群筛选；两次计数且不改页面', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  const result = await issued(await issue(f, 1));
  // New full and gray versions appear after the token was issued.
  await publishPointers(h, f);
  const before = await contentSnapshot(h, f.appId);
  const auditBefore = await audits(h, f.appId);
  const storedToken = await tokenRow(h, f, result.token);
  for (let n = 1; n <= 2; n += 1) {
    expect(await previewed(await read(f, result.token))).toEqual({
      page_key: 'home',
      version: 1,
      sections: SECTIONS,
    });
    expect(await tokenRow(h, f, result.token)).toEqual({ ...storedToken, used_count: n });
  }
  expect(await contentSnapshot(h, f.appId)).toEqual(before);
  expect(await audits(h, f.appId)).toEqual(auditBefore);
  expect(f.lines.join('\n')).not.toContain(result.token);
});

it('[AC-F1-09e#10] 到期前 1ms 可读，到期瞬间及之后 30701，无缓存放行且失败不计数', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  const result = await issued(await issue(f, 1));
  f.clock.advanceMs(599_999);
  expect(await previewed(await read(f, result.token))).toMatchObject({ version: 1 });
  expect((await tokenRow(h, f, result.token)).used_count).toBe(1);
  f.clock.advanceMs(1);
  const before = await snapshot(h, f);
  const expired = await rejected(await read(f, result.token), 'preview', 30701);
  f.clock.advanceMs(1);
  expect(await rejected(await read(f, result.token), 'preview', 30701)).toEqual(expired);
  expect(await snapshot(h, f)).toEqual(before);
});

it('[AC-F1-09e#11] 错 token、另一已存在页、另一 app、过期一律同一 30701 信封，失败无写入', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  await seedVersion(h, f, 1, 'draft', 'custom:other');
  const other = { ...f, appId: appId() };
  await seedVersion(h, other, 1);
  const result = await issued(await issue(f, 1));
  const before = await snapshot(h, f);
  const otherBefore = await snapshot(h, other);
  const unknown = await rejected(await read(f, 'x'.repeat(43)), 'preview', 30701);
  expect(await rejected(await read(f, result.token, 'custom:other'), 'preview', 30701)).toEqual(
    unknown,
  );
  expect(
    await rejected(await read(f, result.token, 'home', other.appId), 'preview', 30701),
  ).toEqual(unknown);
  // Public page_key has no pattern: a non-admin-shaped key still gets the same refusal.
  expect(await rejected(await read(f, result.token, 'not-a-page'), 'preview', 30701)).toEqual(
    unknown,
  );
  f.clock.advanceMs(600_000);
  expect(await rejected(await read(f, result.token), 'preview', 30701)).toEqual(unknown);
  expect(await snapshot(h, f)).toEqual(before);
  expect(await snapshot(h, other)).toEqual(otherBefore);
});

it('[AC-F1-09e#12] 有效用户 Bearer 不能代替预览 token，也不改变正确 token 的结果', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  const result = await issued(await issue(f, 1));
  const headers = await userBearer(h, f);
  const before = await snapshot(h, f);
  const anonymous = await rejected(await read(f, 'x'.repeat(43)), 'preview', 30701);
  expect(
    await rejected(await read(f, 'x'.repeat(43), 'home', f.appId, headers), 'preview', 30701),
  ).toEqual(anonymous);
  await rejected(await read(f, null, 'home', f.appId, headers), 'preview', 20001);
  expect(await snapshot(h, f)).toEqual(before);
  const guest = await previewed(await read(f, result.token));
  expect(await previewed(await read(f, result.token, 'home', f.appId, headers))).toEqual(guest);
  // x-auth none ignores even a malformed Authorization, not merely valid user sessions.
  expect(
    await previewed(
      await read(f, result.token, 'home', f.appId, { authorization: 'Bearer invalid' }),
    ),
  ).toEqual(guest);
  expect((await tokenRow(h, f, result.token)).used_count).toBe(3);
});

it('[AC-F1-09e#13] query token 必填且长度 1..256，格式错误 20001，不消耗已有 token', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  await issued(await issue(f, 1));
  const before = await snapshot(h, f);
  for (const token of [null, '', 'x'.repeat(257)]) {
    await rejected(await read(f, token), 'preview', 20001);
  }
  for (const token of ['x', 'x'.repeat(256)]) {
    await rejected(await read(f, token), 'preview', 30701);
  }
  expect(await snapshot(h, f)).toEqual(before);
});

it('[AC-F1-09e#14] 同 token 并发预览按命中次数原子累加，拒绝请求不参与计数', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  const result = await issued(await issue(f, 1));
  const before = await contentSnapshot(h, f.appId);
  const responses = await Promise.all(Array.from({ length: 16 }, () => read(f, result.token)));
  for (const response of responses) {
    expect(await previewed(response)).toEqual({ page_key: 'home', version: 1, sections: SECTIONS });
  }
  expect((await tokenRow(h, f, result.token)).used_count).toBe(16);
  const mixed = await Promise.all([
    read(f, result.token),
    read(f, result.token, 'custom:missing'),
    read(f, 'x'.repeat(43)),
    read(f, result.token),
  ]);
  await previewed(mixed[0]!);
  await rejected(mixed[1]!, 'preview', 30701);
  await rejected(mixed[2]!, 'preview', 30701);
  await previewed(mixed[3]!);
  expect((await tokenRow(h, f, result.token)).used_count).toBe(18);
  expect(await contentSnapshot(h, f.appId)).toEqual(before);
});

it('[AC-F1-09e#15] 在另一环境数据库无法使用已签发 token，即使 app/page/version 相同', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  const result = await issued(await issue(f, 1));
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app') }).withSchema('app');
  let api: HttpApp | undefined;
  try {
    // Another isolated migrated database represents another environment; no token row copied.
    // Seed an admin for FK validity, preserving the same business identifiers.
    await db
      .insertInto('admin_users')
      .values(
        await h.db
          .selectFrom('admin_users')
          .selectAll()
          .where('id', '=', f.actor.id)
          .executeTakeFirstOrThrow(),
      )
      .execute();
    await seedVersion({ ...h, db }, f, 1);
    api = await (
      await factory()
    )('api', {
      ...f.overrides,
      dbHandles: { db, dbRead: null, close: async () => undefined },
    });
    await api.init();
    assertRoute(api, 'GET', PREVIEW);
    const before = await snapshot({ ...h, db }, f);
    const unknown = await rejected(await read(f, 'x'.repeat(43)), 'preview', 30701);
    expect(
      await rejected(await read(f, result.token, 'home', f.appId, {}, api), 'preview', 30701),
    ).toEqual(unknown);
    expect(await snapshot({ ...h, db }, f)).toEqual(before);
    expect((await tokenRow(h, f, result.token)).used_count).toBe(0);
    expect(await previewed(await read(f, result.token))).toMatchObject({ version: 1 });
  } finally {
    await api?.close();
    await destroyDb(db);
    await database.drop();
  }
});

it('[AC-F1-09e#16] preview 只在 api 入口，签发只在 admin 入口', async () => {
  const f = await setup(h);
  // Assert opposite-entry route absence without relying on unrelated global 404 envelopes.
  const publicServer = f.api.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  expect(
    publicServer.hasRoute({ method: 'POST', url: ISSUE.replace('{page_key}', ':page_key') }),
  ).toBe(false);
  expect(
    f.app
      .getHttpAdapter()
      .getInstance()
      .hasRoute({
        method: 'GET',
        url: PREVIEW.replace('{page_key}', ':page_key'),
      }),
  ).toBe(false);
});

it('[AC-F1-09e#18] 审计写入失败时签发整体失败，不能留下无审计的 token', async () => {
  const f = await setup(h);
  await seedVersion(h, f, 1);
  const before = await snapshot(h, f);
  let attempts = 0;
  // Inject only a storage failure: keep the real controller, guard and transaction writer.
  const failAudit: KyselyPlugin = {
    transformQuery({ node }) {
      if (node.kind === 'InsertQueryNode' && node.into?.table.identifier.name === 'audit_logs') {
        attempts += 1;
        throw new Error('synthetic audit storage failure');
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  const app = await (
    await factory()
  )('admin', {
    ...f.overrides,
    dbHandles: { db: h.db.withPlugin(failAudit), dbRead: null, close: async () => undefined },
  });
  h.apps.push(app);
  await app.init();
  assertRoute(app, 'POST', ISSUE);
  await rejected(await issue({ ...f, app }, 1), 'issue', 50001);
  expect(attempts).toBeGreaterThan(0);
  expect(await snapshot(h, f)).toEqual(before);
});
