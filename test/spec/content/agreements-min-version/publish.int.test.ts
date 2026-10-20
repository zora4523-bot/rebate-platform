// F1-02zr §9.2#1 / §9.3#1–3: real admin route, PostgreSQL writes and transaction rollback.
import type { KyselyPlugin } from 'kysely';
import { expect, it } from 'vitest';
import {
  MIN_KEY,
  VERSION_KEY,
  config,
  factory,
  input,
  publish,
  publishOk,
  rejected,
  setup,
  snapshot,
  stepUp,
  useHarness,
} from './kit.ts';

const h = useHarness(() => import('@couli/db/testing'));

it('[AC-F1-02zr#3] 首发及逐版发布写请求 min_version，两键各自递增修订并逐次记录历史', async () => {
  const f = await setup(h);
  // Version is server-generated: reaching version 3 requires three publishes.
  for (const [version, minimum] of [
    [1, 1],
    [2, 1],
    [3, 2],
  ] as const) {
    const result = await publishOk(f, 'agreement', {
      expected_version: version - 1,
      min_version: minimum,
    });
    expect(result).toMatchObject({ version, min_version: minimum, requires_resign: false });
    const state = await snapshot(h, f.appId);
    expect(state.items.filter((row) => row.key.startsWith('legal.'))).toEqual([
      expect.objectContaining({
        key: MIN_KEY,
        value: minimum,
        version,
        updated_by: f.actor.username,
        updated_at: f.clock.now(),
      }),
      expect.objectContaining({
        key: VERSION_KEY,
        value: version,
        version,
        updated_at: f.clock.now(),
      }),
    ]);
    for (const key of [MIN_KEY, VERSION_KEY]) {
      const history = state.versions.filter((row) => row.key === key);
      expect(history).toHaveLength(version);
      expect(history.at(-1)).toMatchObject({
        value: key === MIN_KEY ? minimum : version,
        version,
        updated_by: f.actor.username,
        updated_by_admin_id: f.actor.id,
        reason: 'agreement_publish',
        created_at: f.clock.now(),
      });
    }
    expect(state.articles).toHaveLength(version);
    expect(state.agreements).toHaveLength(version);
    expect(state.audits.filter((row) => row.action === 'agreement_publish')).toHaveLength(version);
  }
  const state = await snapshot(h, f.appId);
  expect(state.versions.filter((row) => row.key === MIN_KEY).map((row) => row.value)).toEqual([
    1, 1, 2,
  ]);
});

it('[AC-F1-02zr#4] 配置中较大的最低版本可以回写为请求值，其他协议及其他 app 不碰它', async () => {
  const f = await setup(h);
  const other = await setup(h);
  await config(h, other.appId, MIN_KEY, 9, 4);
  const foreign = await snapshot(h, other.appId);
  // Existing config may be ahead; only the agreement row constrains publish min_version.
  await config(h, f.appId, MIN_KEY, 9, 4);
  await publishOk(f, 'agreement');
  const first = await snapshot(h, f.appId);
  expect(first.items.find((row) => row.key === MIN_KEY)).toMatchObject({ value: 1, version: 5 });
  expect(first.versions.filter((row) => row.key === MIN_KEY)).toEqual([
    expect.objectContaining({ value: 1, version: 5 }),
  ]);
  for (const type of ['privacy', 'labor_agreement'] as const) {
    await publishOk(f, type, { requires_resign: type === 'labor_agreement' });
    const after = await snapshot(h, f.appId);
    expect(after.items.filter((row) => row.key.startsWith('legal.agreement.'))).toEqual(
      first.items.filter((row) => row.key.startsWith('legal.agreement.')),
    );
    expect(after.versions.filter((row) => row.key.startsWith('legal.agreement.'))).toEqual(
      first.versions.filter((row) => row.key.startsWith('legal.agreement.')),
    );
    expect(after.items.some((row) => row.key.startsWith('legal.labor_agreement.'))).toBe(false);
  }
  expect(await snapshot(h, other.appId)).toEqual(foreign);
});

it.each([false, true])(
  '[AC-F1-02zr#5] 已有配置=%s，最低版本历史已写后失败则文章、协议、两键、历史、审计全部回滚',
  async (existing) => {
    const f = await setup(h);
    if (existing) {
      await publishOk(f, 'agreement');
    }
    const step = await stepUp(f);
    const before = await snapshot(h, f.appId);
    let reached = false;
    const targets = new WeakSet<object>();
    const completed: string[] = [];
    const tables = new WeakMap<object, string>();
    const fault: KyselyPlugin = {
      transformQuery({ node, queryId }) {
        if (node.kind === 'InsertQueryNode' && node.into !== undefined) {
          const table = node.into.table.identifier.name;
          tables.set(queryId, table);
          // Bigint nodes may occur in Kysely ASTs; never let instrumentation cause a TypeError.
          const text = JSON.stringify(node, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          );
          if (table === 'config_item_versions' && text.includes(MIN_KEY)) targets.add(queryId);
        }
        return node;
      },
      async transformResult({ result, queryId }) {
        const table = tables.get(queryId);
        if (table !== undefined) completed.push(table);
        if (targets.has(queryId)) {
          reached = true;
          throw new Error('synthetic minimum history failure');
        }
        return result;
      },
    };
    // Keep the pool, so an incorrect out-of-transaction write cannot accidentally join the trx.
    const db = h.db.withPlugin(fault);
    const app = await (
      await factory()
    )('admin', {
      ...f.overrides,
      dbHandles: { db, dbRead: null, close: async () => undefined },
    });
    h.apps.push(app);
    await app.init();
    const sent = await publish(
      { app, token: f.token },
      'agreement',
      input({ expected_version: existing ? 1 : 0 }),
      step,
    );
    expect(reached, 'must reach the minimum-version history write').toBe(true);
    await rejected(sent, 'publish', 50001);
    expect(completed).toEqual(
      expect.arrayContaining(['articles', 'agreements', 'config_item_versions']),
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-F1-02zr#6] L44 的 version 在前仍返回 20902，修正版本后才原子发布两键', async () => {
  const f = await setup(h);
  await config(h, f.appId, VERSION_KEY, 1);
  await config(h, f.appId, MIN_KEY, 8, 3);
  const token = await stepUp(f);
  const before = await snapshot(h, f.appId);
  await rejected(await publish(f, 'agreement', input(), token), 'publish', 20902, {
    resource: 'agreement',
  });
  expect(await snapshot(h, f.appId)).toEqual(before);
  await h.db
    .updateTable('config_items')
    .set({ value: 0 })
    .where('app_id', '=', f.appId)
    .where('key', '=', VERSION_KEY)
    .execute();
  await publishOk(f, 'agreement');
  const after = await snapshot(h, f.appId);
  expect(after.items.find((row) => row.key === MIN_KEY)).toMatchObject({ value: 1, version: 4 });
  expect(after.items.find((row) => row.key === VERSION_KEY)).toMatchObject({
    value: 1,
    version: 2,
  });
  expect(after.versions.filter((row) => row.key === MIN_KEY)).toHaveLength(1);
});
