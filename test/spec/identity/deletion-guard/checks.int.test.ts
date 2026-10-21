// Direct calls of stage ⑥'s two parts (B1-15e §9.2 #1–#3, §9.2 #6 items 1, 3–5, 7–9). Planned
// routes (POST /v1/me/deletion/cancel, GET /v1/me/deletion, POST /v1/me/deletion) are proven here
// by their Fastify route template, as B1-02zh's checks did; HTTP level uses live routes only.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type * as Guard from '../../../../apps/api/src/modules/identity/application/deletion-guard.ts';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';
import type * as Scope from '../../../../apps/api/src/modules/risk/application/minimum-version.ts';
import {
  NOW,
  ROOT,
  UNAVAILABLE,
  activate,
  cancel,
  deletion,
  failing,
  identity,
  noKey,
  observe,
  refusal,
  request,
  user,
  userStatus,
} from './kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: ReturnType<typeof createDb>;
let api: typeof Guard;
let platform: typeof Platform;
let scope: typeof Scope;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  api = await identity();
  platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof Platform;
  scope = (await import(
    new URL('apps/api/src/modules/risk/application/minimum-version.ts', ROOT).href
  )) as typeof Scope;
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

async function subject(status = 'normal') {
  const appId = `del_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const uid = await user(db, appId, status);
  return { appId, uid };
}

const WHITELIST = [
  ['GET', '/v1/me'],
  ['HEAD', '/v1/me'],
  ['GET', '/v1/invites/me'],
  ['GET', '/v1/me/deletion'],
  ['POST', '/v1/me/deletion/cancel'],
  ['POST', '/v1/auth/logout'],
  ['POST', '/v1/idempotency-keys/abandon'],
  ['POST', '/v1/auth/refresh'],
  ['POST', '/v1/consents'],
  ['GET', '/v1/agent/sessions/current'],
] as const;

for (const stage of ['cooling', 'processing', 'done'] as const) {
  it(`[AC-B1-15e#3] ${stage} 用户的白名单与 GET 逐项放行，守卫与 post-miss 都不发任何查询`, async () => {
    const s = await subject();
    await deletion(db, s.appId, s.uid, stage);
    const { executor, statements } = observe(db);
    const checks = api.createDeletionStageChecks({ db: executor });
    // Positive control: the same checks refuse this user on a write outside the whitelist.
    const write = request(s.appId, s.uid);
    await expect(activate(checks, write)).rejects.toMatchObject(
      refusal(write.id, stage === 'cooling' ? 'cooling' : 'processing'),
    );
    statements.length = 0;
    for (const [method, path] of WHITELIST) {
      const input = request(s.appId, s.uid, method, path);
      await expect(activate(checks, input), `${method} ${path}`).resolves.toBe(true);
      await expect(
        scope.MINIMUM_VERSION_SCOPE.run({ request: input, idempotencyEntered: false }, () =>
          checks.postMiss({
            appId: s.appId,
            actor: { userId: s.uid, deviceId: null, phoneHmac: null },
            // The command's own method is irrelevant: the route judged is the scope's request.
            method: 'POST',
            path,
            key: randomUUID(),
            body: {},
            traceId: input.id,
          }),
        ),
        `${method} ${path}`,
      ).resolves.toBeUndefined();
    }
    expect(statements).toEqual([]);
  });
}

for (const [label, seed, stage] of [
  ['users.status=deleting（无单）', 'deleting', 'processing'],
  ['processing 单', 'processing', 'processing'],
  ['done 单的残留会话', 'done', 'processing'],
  ['users.status=deleted 的残留会话', 'deleted', 'processing'],
  ['冷静期单', 'cooling', 'cooling'],
] as const) {
  it(`[AC-B1-15e#4] ${label} → 10007 stage=${stage}，trace_id 是本请求 id`, async () => {
    const s = await subject();
    if (seed === 'deleting' || seed === 'deleted') await userStatus(db, s.appId, s.uid, seed);
    else await deletion(db, s.appId, s.uid, seed);
    const checks = api.createDeletionStageChecks({ db });
    const input = request(s.appId, s.uid);
    await expect(activate(checks, input)).rejects.toMatchObject(refusal(input.id, stage));
  });
}

it('[AC-B1-15e#5] 无单、只有 cancelled 单放行；cancelled 历史加新 cooling 单 → cooling', async () => {
  const s = await subject();
  const checks = api.createDeletionStageChecks({ db });
  await expect(activate(checks, request(s.appId, s.uid))).resolves.toBe(true);
  await deletion(db, s.appId, s.uid, 'cancelled', '2026-09-01T00:00:00Z');
  await deletion(db, s.appId, s.uid, 'cancelled', '2026-09-20T00:00:00Z');
  await expect(activate(checks, request(s.appId, s.uid))).resolves.toBe(true);
  await deletion(db, s.appId, s.uid, 'cooling');
  const input = request(s.appId, s.uid);
  await expect(activate(checks, input)).rejects.toMatchObject(refusal(input.id, 'cooling'));
});

it('[AC-B1-15e#5] 冷静期已过、定时任务未执行的 cooling 单仍返回 stage=cooling', async () => {
  const s = await subject();
  // Applied 8 days before NOW: cooling_until is a day past, the row still says cooling.
  await deletion(db, s.appId, s.uid, 'cooling', '2026-10-09T02:00:00Z');
  const checks = api.createDeletionStageChecks({ db });
  const input = request(s.appId, s.uid, 'POST', '/v1/links/convert');
  await expect(activate(checks, input)).rejects.toMatchObject(refusal(input.id, 'cooling'));
});

it('[AC-B1-15e#7] 守卫逐请求查库不缓存：插入 cooling 立即拒绝，撤回后立即放行', async () => {
  const s = await subject();
  const { executor, statements } = observe(db);
  const checks = api.createDeletionStageChecks({ db: executor });
  await expect(activate(checks, request(s.appId, s.uid))).resolves.toBe(true);
  const id = await deletion(db, s.appId, s.uid, 'cooling');
  const input = request(s.appId, s.uid);
  await expect(activate(checks, input)).rejects.toMatchObject(refusal(input.id, 'cooling'));
  await cancel(db, id);
  await expect(activate(checks, request(s.appId, s.uid))).resolves.toBe(true);
  expect(statements).toHaveLength(3);
  for (const statement of statements) expect(statement).toContain('deletion_requests');
});

for (const mode of ['allow', 'refuse', 'processing', 'failure'] as const) {
  it(`[AC-B1-15e#7] post-miss ${mode}：在 claim 事务上读到未提交的单，不借池连接；拒绝不留键、后续不执行`, async () => {
    const s = await subject();
    const path = '/v1/me/favorites/:platform/:product_key';
    const input = request(s.appId, s.uid, 'PUT', path);
    const key = randomUUID();
    let reading = false;
    const handle = db.withPlugin({
      transformQuery(args) {
        if (reading && mode === 'failure') throw new Error('fixture read failed');
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const checks = api.createDeletionStageChecks({
      db: failing(db, 'must not borrow pooled connection'),
    });
    const idem = platform.createIdempotency({
      db: handle.withSchema('app'),
      clock: new platform.FixedClock(NOW),
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    platform.registerIdempotencyPostMissCheck(idem, async () => {
      const trx = platform.idempotencyPostMissTransaction()!;
      if (mode === 'allow') await deletion(trx, s.appId, s.uid, 'cancelled');
      else if (mode === 'processing') await userStatus(trx, s.appId, s.uid, 'deleting');
      else await deletion(trx, s.appId, s.uid, 'cooling');
    });
    const seen = vi.fn();
    platform.registerIdempotencyPostMissCheck(idem, async (command) => {
      seen();
      reading = true;
      try {
        await checks.postMiss(command);
      } finally {
        reading = false;
      }
    });
    const later = vi.fn(async () => {});
    platform.registerIdempotencyPostMissCheck(idem, later);
    const business = vi.fn(async () => ({
      status: 200,
      envelope: { code: 0, msg: '', data: {}, trace_id: input.id },
    }));
    const run = () =>
      scope.MINIMUM_VERSION_SCOPE.run({ request: input, idempotencyEntered: false }, () =>
        idem.executeInTransaction(
          {
            appId: s.appId,
            actor: { userId: s.uid, deviceId: null, phoneHmac: null },
            method: 'PUT',
            path,
            key,
            body: {},
            traceId: input.id,
          },
          business,
        ),
      );
    if (mode === 'allow') {
      expect((await run()).status).toBe(200);
      expect(later).toHaveBeenCalledTimes(1);
      expect(business).toHaveBeenCalledTimes(1);
    } else {
      await expect(run()).rejects.toMatchObject(
        mode === 'failure'
          ? UNAVAILABLE
          : refusal(input.id, mode === 'refuse' ? 'cooling' : 'processing'),
      );
      expect(later).not.toHaveBeenCalled();
      expect(business).not.toHaveBeenCalled();
      await noKey(db, s.appId, key);
      // Rolled back with the claim: the uncommitted row never became visible to others.
      const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.deletion_requests
        WHERE app_id = ${s.appId} AND user_id = ${s.uid}`.execute(db);
      expect(rows.rows).toEqual([{ n: 0 }]);
    }
    expect(seen).toHaveBeenCalledTimes(1);
  });
}

it('[AC-B1-15e#3] 守卫跳过 x-idempotent 操作（交 post-miss，④ 回放在前），不读库', async () => {
  const s = await subject();
  await deletion(db, s.appId, s.uid, 'cooling');
  const { executor, statements } = observe(db);
  const checks = api.createDeletionStageChecks({ db: executor });
  for (const [method, path] of [
    ['PUT', '/v1/me/favorites/:platform/:product_key'],
    ['PUT', '/v1/me/payout-account'],
    ['POST', '/v1/me/appeals'],
    ['POST', '/v1/me/deletion'],
  ] as const) {
    await expect(activate(checks, request(s.appId, s.uid, method, path))).resolves.toBe(true);
  }
  expect(statements).toEqual([]);
  // Positive control: the same checks read and refuse a non-idempotent write.
  const input = request(s.appId, s.uid, 'POST', '/v1/me/tips/:tip_key/read');
  await expect(activate(checks, input)).rejects.toMatchObject(refusal(input.id, 'cooling'));
  expect(statements).toHaveLength(1);
});

it('[AC-B1-15e#3] 无 HTTP scope 的直接幂等调用跳过，不读库', async () => {
  const s = await subject();
  await deletion(db, s.appId, s.uid, 'cooling');
  const checks = api.createDeletionStageChecks({ db: null });
  await expect(
    checks.postMiss({
      appId: s.appId,
      actor: { userId: s.uid, deviceId: null, phoneHmac: null },
      method: 'POST',
      path: '/v1/me/deletion',
      key: randomUUID(),
      body: {},
      traceId: randomUUID(),
    }),
  ).resolves.toBeUndefined();
});

it('[AC-B1-15e#8] 只看令牌主体：A 的单不影响 B，body 与头里伪造的 user_id / app_id 不起作用', async () => {
  const a = await subject();
  const uidB = await user(db, a.appId);
  await deletion(db, a.appId, a.uid, 'cooling');
  const checks = api.createDeletionStageChecks({ db });
  await expect(
    activate(checks, request(a.appId, uidB, 'PATCH', '/v1/me', { appId: a.appId, uid: a.uid })),
  ).resolves.toBe(true);
  const forgedToB = request(a.appId, a.uid, 'PATCH', '/v1/me', { appId: a.appId, uid: uidB });
  await expect(activate(checks, forgedToB)).rejects.toMatchObject(refusal(forgedToB.id, 'cooling'));
});

it('[AC-B1-15e#8] app_id 隔离：另一 app 下同一 uid 查不到本 app 的单', async () => {
  const a = await subject();
  const other = await subject();
  await deletion(db, a.appId, a.uid, 'cooling');
  const checks = api.createDeletionStageChecks({ db });
  // users.id is globally unique and deletion_requests has a composite FK, so the same uid cannot
  // have rows in two apps: an omitted app_id predicate would wrongly find a's cooling request.
  await expect(activate(checks, request(other.appId, a.uid))).resolves.toBe(true);
  const input = request(a.appId, a.uid);
  await expect(activate(checks, input)).rejects.toMatchObject(refusal(input.id, 'cooling'));
});

for (const [method, path] of [
  ['POST', '/v1/auth/sms-codes'],
  ['POST', '/v1/auth/login/sms'],
  ['POST', '/v1/auth/login/wechat'],
  ['POST', '/v1/auth/login/apple'],
  ['POST', '/v1/auth/login/huawei'],
  ['POST', '/v1/devices'],
  ['POST', '/v1/landing/sms-codes'],
  ['POST', '/v1/invites/landing-register'],
  ['POST', '/v1/auth/oauth-attempts'],
  ['POST', '/v1/inputs/parse'],
  ['POST', '/v1/links/:link_id/open'],
  ['POST', '/__deletion_unknown'],
] as const) {
  it(`[AC-B1-15e#9] x-auth none / 非 agent optional / 契约外 ${method} ${path} 不判、不读库`, async () => {
    const s = await subject();
    await deletion(db, s.appId, s.uid, 'cooling');
    const checks = api.createDeletionStageChecks({ db: null });
    await expect(activate(checks, request(s.appId, s.uid, method, path))).resolves.toBe(true);
  });
}

for (const path of [
  '/v1/agent/sessions',
  '/v1/agent/sessions/:id/messages',
  '/v1/agent/runs/:run_id/cancel',
] as const) {
  it(`[AC-B1-15e#9] /v1/agent/ 写接口 POST ${path} 带令牌也判 10007；无令牌不判不读`, async () => {
    const s = await subject();
    await deletion(db, s.appId, s.uid, 'cooling');
    const anonymous = api.createDeletionStageChecks({ db: null });
    await expect(activate(anonymous, request(s.appId, null, 'POST', path))).resolves.toBe(true);
    const checks = api.createDeletionStageChecks({ db });
    const input = request(s.appId, s.uid, 'POST', path);
    await expect(activate(checks, input)).rejects.toMatchObject(refusal(input.id, 'cooling'));
    await userStatus(db, s.appId, s.uid, 'deleting');
    const later = request(s.appId, s.uid, 'POST', path);
    await expect(activate(checks, later)).rejects.toMatchObject(refusal(later.id, 'processing'));
  });
}

for (const failure of ['no-db', 'read'] as const) {
  it(`[AC-B1-15e#9] ${failure === 'no-db' ? '进程无库' : '读失败'} → 50001，不放行`, async () => {
    const s = await subject();
    const checks = api.createDeletionStageChecks({
      db: failure === 'no-db' ? null : failing(db),
    });
    await expect(activate(checks, request(s.appId, s.uid))).rejects.toMatchObject(UNAVAILABLE);
    await expect(
      activate(checks, request(s.appId, s.uid, 'POST', '/v1/agent/sessions')),
    ).rejects.toMatchObject(UNAVAILABLE);
    // A whitelisted route is decided before any read, so it still goes on.
    await expect(
      activate(checks, request(s.appId, s.uid, 'POST', '/v1/me/deletion/cancel')),
    ).resolves.toBe(true);
  });
}
