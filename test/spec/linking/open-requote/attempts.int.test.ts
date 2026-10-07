import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  attempts,
  databaseFixture,
  fixture,
  openLogs,
  reprice,
  service,
  source,
  stored,
  success,
  USER_A,
  USER_B,
} from './kit.ts';

const database = databaseFixture();

it.each(['ios', 'android', 'harmony', 'h5', 'web'] as const)(
  '[AC-B1-06k#20] BR-ATTR-14/21：%s 成功 open 写完整证据与 UUIDv7 尝试，使用注入时钟',
  async (client) => {
    const db = database();
    const f = fixture(db);
    const original = await source(f);
    f.convert.mockImplementationOnce(async () => {
      f.clock.advanceMs(125);
      return {
        primary: { type: 'h5', value: 'https://example.invalid/synthetic-latency' },
        fallbacks: [],
        expire_at: '2031-06-06T07:08:09.000Z',
      };
    });
    const result = success(await service(f).open(f.request(original.link_id, { client })));
    expect(result.attempt_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const effective = result.new_link_id ?? original.link_id;
    expect(await attempts(db, effective)).toEqual([
      expect.objectContaining({
        attempt_id: result.attempt_id,
        app_id: 'register-app',
        link_id: effective,
        user_id: USER_A,
        opened_at: f.clock.now(),
        jump_reported_at: null,
        dismissed_at: null,
      }),
    ]);
    expect(await openLogs(db, effective)).toEqual([
      expect.objectContaining({
        app_id: 'register-app',
        link_id: effective,
        event: 'open',
        client,
        user_id: USER_A,
        opener_user_id: USER_A,
        platform: original.platform,
        product_key: original.product_key,
        raw_item_id: original.raw_item_id,
        scene: original.scene,
        pid_scene: original.pid_scene,
        pid: original.pid,
        quoted_price_fen: 2990n,
        cache_hit: false,
        expired: false,
        result_code: 0,
        latency_ms: 125,
        created_at: f.clock.now(),
      }),
    ]);
    const rows = await sql<{ log_xid: string; attempt_xid: string }>`
      SELECT l.xmin::text AS log_xid, a.xmin::text AS attempt_xid
      FROM app.link_logs l JOIN app.link_open_attempts a ON a.link_id = l.link_id
      WHERE l.event = 'open' AND a.attempt_id = ${result.attempt_id}::uuid
    `.execute(db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.log_xid).toBe(rows.rows[0]!.attempt_xid);
  },
);

it.each([USER_B, null])(
  '[AC-B1-06k#21] BR-ATTR-14/21：分享由 %s 打开，日志归分享者，attempt 归打开者',
  async (opener) => {
    const db = database();
    const f = fixture(db, { userId: opener });
    const original = await source(f, 2990n, {}, { scene: 'share' });
    const result = success(await service(f).open(f.request(original.link_id)));
    expect(await openLogs(db, original.link_id)).toEqual([
      expect.objectContaining({ user_id: USER_A, opener_user_id: opener, result_code: 0 }),
    ]);
    expect(await attempts(db, original.link_id)).toEqual([
      expect.objectContaining({ attempt_id: result.attempt_id, user_id: opener }),
    ]);
  },
);

it.each(['search', 'share'] as const)(
  '[AC-B1-06k#22] BR-ATTR-11/G-08：%s 新建归属 link，日志和 attempt 都落在新 id',
  async (scene) => {
    const db = database();
    const opener = scene === 'share' ? USER_A : USER_B;
    const f = fixture(db, { userId: opener });
    const original = await source(f, 2990n, {}, { scene });
    const result = success(await service(f).open(f.request(original.link_id)));
    expect(result.new_link_id).toEqual(expect.any(String));
    const replacement = await stored(db, result.new_link_id!);
    expect(await openLogs(db, original.link_id)).toEqual([]);
    expect(await attempts(db, original.link_id)).toEqual([]);
    expect(await openLogs(db, replacement.link_id)).toEqual([
      expect.objectContaining({
        link_id: replacement.link_id,
        user_id: opener,
        opener_user_id: opener,
        pid_scene: 'self_buy',
        result_code: 0,
      }),
    ]);
    expect(await attempts(db, replacement.link_id)).toEqual([
      expect.objectContaining({ attempt_id: result.attempt_id, user_id: opener }),
    ]);
  },
);

it.each([false, true])(
  '[AC-B1-06k#23] BR-ATTR-14：expired=%s 的 link 都能 open，日志如实记过期状态',
  async (expired) => {
    const db = database();
    const f = fixture(db);
    const original = await source(f);
    f.clock.set(new Date(original.expire_at.getTime() + (expired ? 1 : -1)));
    const result = success(await service(f).open(f.request(original.link_id)));
    expect(await openLogs(db, result.new_link_id ?? original.link_id)).toEqual([
      expect.objectContaining({ expired, result_code: 0 }),
    ]);
    expect((await stored(db, original.link_id)).expire_at).toEqual(original.expire_at);
  },
);

it('[AC-B1-06k#24] 同键重放跨服务实例、超出单飞窗口：保持首个 new_link_id/attempt/jump，不再取价记日志', async () => {
  const db = database();
  const f = fixture(db, { userId: USER_B });
  const original = await source(f);
  reprice(f, 3090n);
  const request = f.request(original.link_id);
  const first = success(await service(f).open(request));
  const before = await db.selectFrom('links').select('link_id').execute();
  f.clock.advanceMs(8001);
  reprice(f, 3990n);
  const replay = success(await service(f).open({ ...request, traceId: 'synthetic-second-trace' }));
  expect(replay).toEqual(first);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.convert).toHaveBeenCalledTimes(1);
  expect(await db.selectFrom('links').select('link_id').execute()).toEqual(before);
  expect(await openLogs(db, first.new_link_id!)).toHaveLength(1);
  expect(await attempts(db, first.new_link_id!)).toHaveLength(1);
  expect(f.execute).toHaveBeenCalledTimes(2);
  const storedKey = await db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('app_id', '=', 'register-app')
    .where('key', '=', request.idempotencyKey)
    .where('path', '=', `/v1/links/${original.link_id}/open`)
    .execute();
  expect(storedKey).toEqual([expect.objectContaining({ status: 'completed', user_id: USER_B })]);
});

it('[AC-B1-06k#25] BR-ATTR-14：30141 的同键重放也只记首次失败 open，无 attempt', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  f.state.price = { kind: 'off_shelf' };
  const request = f.request(original.link_id);
  const s = service(f);
  expect(await s.open(request)).toEqual({ code: 30141, data: null });
  f.clock.advanceMs(8001);
  expect(await service(f).open(request)).toEqual({ code: 30141, data: null });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(await openLogs(db, original.link_id)).toHaveLength(1);
  expect(await attempts(db, original.link_id)).toEqual([]);
});

it.each(['link_logs', 'link_open_attempts'] as const)(
  '[AC-B1-06k#26] 同事务：%s 插入后故障回滚两种记录，不留下半条成功证据',
  async (table) => {
    const db = database();
    const inserts = new WeakSet<object>();
    let injected = false;
    const observedDb = db.withPlugin({
      transformQuery({ node, queryId }) {
        if (node.kind === 'InsertQueryNode' && node.into?.table.identifier.name === table) {
          inserts.add(queryId);
        }
        return node;
      },
      async transformResult({ queryId, result }) {
        if (inserts.has(queryId)) {
          injected = true;
          throw new Error('synthetic-write-failure');
        }
        return result;
      },
    });
    const f = fixture(observedDb);
    const original = await source(f);
    const s = service(f);
    const result = await s.open(f.request(original.link_id)).then(
      (value) => ({ returned: value }),
      (error: unknown) => ({ rejected: error }),
    );
    expect(injected).toBe(true);
    expect(result).not.toMatchObject({ returned: { code: 0 } });
    expect(await openLogs(db, original.link_id)).toEqual([]);
    expect(await attempts(db, original.link_id)).toEqual([]);
  },
);
