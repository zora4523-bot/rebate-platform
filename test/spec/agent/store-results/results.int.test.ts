import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { DeliveredProduct } from '../../../../apps/api/src/modules/agent/orchestrator/results/types.ts';
import { APP, OTHER_APP, databaseKit, delivered, product, input } from './kit.ts';

const h = databaseKit();

it('[AC-B3-09c#1][BR-AI-05] save 原样存条件，重复不增行，未投递结果不可见', async () => {
  const store = h.store();
  const scope = await h.scope();
  const value = input(scope);
  await store.save(value);
  await h.store().save(value);
  const rows = await sql<Record<string, unknown>>`SELECT * FROM app.agent_result_sets
    WHERE id = ${value.id}`.execute(h.db());
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]).toEqual({
    id: value.id,
    app_id: APP,
    run_id: scope.runId,
    conditions: value.conditions,
    created_at: expect.any(Date),
  });
  expect(await store.latestWithProducts(APP, scope.sessionId)).toBeNull();
  const receipts = await sql`SELECT * FROM app.agent_result_deliveries
    WHERE result_set_id = ${value.id}`.execute(h.db());
  expect(receipts.rows).toEqual([]);
});

it('[AC-B3-09c#1][BR-AI-05] save 拒绝不存在、他会话和他 app 的 run，失败不落行', async () => {
  const store = h.store();
  const own = await h.scope();
  const otherSession = await h.scope();
  const otherApp = await h.scope(OTHER_APP);
  for (const foreign of [
    { ...own, runId: randomUUID() },
    { ...own, runId: otherSession.runId },
    { ...otherApp, appId: APP },
  ]) {
    const value = input(foreign);
    await expect(store.save(value)).rejects.toThrow();
    expect(
      (await sql`SELECT id FROM app.agent_result_sets WHERE id = ${value.id}`.execute(h.db())).rows,
    ).toEqual([]);
  }
});

it('[AC-B3-09c#2][BR-AI-05] 投递归属来自结果集，按投递序持久化原卡且重复并发不增行', async () => {
  const store = h.store();
  const secondStore = h.store();
  const scope = await h.scope();
  const value = input(scope);
  const a = delivered('c9', product('jd:synthetic-second', 3000));
  const b = delivered('c2', product('jd:synthetic-first', 2000));
  const c = delivered('c7', product('jd:synthetic-zero', 0));
  await store.save(value);
  // Runtime extra identity fields cannot override the saved run's ownership.
  const forged: DeliveredProduct & { appId: string; sessionId: string; runId: string } = {
    ...a,
    appId: OTHER_APP,
    sessionId: randomUUID(),
    runId: randomUUID(),
  };
  await Promise.all([
    store.recordDelivered(value.id, [forged, b]),
    secondStore.recordDelivered(value.id, [forged, b]),
  ]);
  await secondStore.recordDelivered(value.id, [a, b]);
  await store.recordDelivered(value.id, [c]);
  const rows = await sql<Record<string, unknown>>`SELECT app_id, session_id, run_id,
    result_set_id, position, card_id, product_key, platform, final_price_fen, card
    FROM app.agent_result_deliveries WHERE result_set_id = ${value.id} ORDER BY position`.execute(
    h.db(),
  );
  expect(rows.rows).toEqual(
    [a, b, c].map((item, index) => ({
      app_id: scope.appId,
      session_id: scope.sessionId,
      run_id: scope.runId,
      result_set_id: value.id,
      position: index + 1,
      card_id: item.card_id,
      product_key: item.product_key,
      platform: item.platform,
      final_price_fen: BigInt(item.final_price_fen),
      card: item.card,
    })),
  );
  expect(await h.store().latestWithProducts(APP, scope.sessionId)).toEqual({
    ...value,
    delivered: [a, b, c],
  });
});

it('[AC-B3-09c#2][BR-AI-05] 未知或非 UUID 结果集投递被忽略', async () => {
  const store = h.store();
  const before =
    await sql`SELECT * FROM app.agent_result_deliveries ORDER BY session_id, card_id`.execute(
      h.db(),
    );
  for (const id of [randomUUID(), 'synthetic-not-uuid', '']) {
    await expect(store.recordDelivered(id, [delivered('c1')])).resolves.toBeUndefined();
  }
  expect(
    (
      await sql`SELECT * FROM app.agent_result_deliveries ORDER BY session_id, card_id`.execute(
        h.db(),
      )
    ).rows,
  ).toEqual(before.rows);
});

it('[AC-B3-09c#3][BR-AI-05] 最近已投递集跳过空集，早轮卡可查，异域同卡号独立且不遮蔽', async () => {
  const store = h.store();
  const own = await h.scope();
  const first = input(own);
  const second = input(await h.run(APP, own.sessionId));
  const a = delivered('c2', product('jd:synthetic-old'));
  const b = delivered('c8', product('jd:synthetic-new'));
  await store.save(first);
  await store.recordDelivered(first.id, [a]);
  await store.save(second);
  await store.recordDelivered(second.id, [b]);
  const empty = input(await h.run(APP, own.sessionId));
  await store.save(empty);
  await store.recordDelivered(empty.id, []);
  for (const foreign of [await h.scope(), await h.scope(OTHER_APP)]) {
    const value = input(foreign);
    const item = delivered('c8', product('jd:synthetic-foreign'));
    await store.save(value);
    await store.recordDelivered(value.id, [item]);
    expect(await store.latestWithProducts(foreign.appId, foreign.sessionId)).toEqual({
      ...value,
      delivered: [item],
    });
    expect(await store.findDelivered(foreign.appId, foreign.sessionId, 'c8')).toEqual(item);
    expect(await store.findDelivered(foreign.appId, foreign.sessionId, 'c2')).toBeNull();
  }
  expect(await h.store().latestWithProducts(APP, own.sessionId)).toEqual({
    ...second,
    delivered: [b],
  });
  expect(await h.store().findDelivered(APP, own.sessionId, 'c2')).toEqual(a);
  for (const [appId, sessionId] of [
    [OTHER_APP, own.sessionId],
    [APP, randomUUID()],
    [APP, 'not-uuid'],
    [APP, ''],
  ] as const) {
    expect(await store.latestWithProducts(appId, sessionId)).toBeNull();
    expect(await store.findDelivered(appId, sessionId, 'c8')).toBeNull();
  }
  for (const cardId of ['c1', 'c999', 'https://example.invalid/product', '']) {
    expect(await store.findDelivered(APP, own.sessionId, cardId)).toBeNull();
  }
});

it('[AC-B3-09c#3][BR-AI-05] 最近按结果集 created_at 降序，同刻按 id 降序，不按投递时间', async () => {
  const store = h.store();
  const scope = await h.scope();
  const clock = new FixedClock('2026-10-22T00:00:00Z');
  const older = { ...input(scope), id: '00000000-0000-4000-8000-000000000003' };
  const lower = { ...input(scope), id: '00000000-0000-4000-8000-000000000001' };
  const higher = { ...input(scope), id: '00000000-0000-4000-8000-000000000002' };
  // Fixture timestamps intentionally tie; no sleeps and no UPDATE on append-only tables.
  for (const value of [older, lower, higher]) {
    await sql`INSERT INTO app.agent_result_sets (id, app_id, run_id, conditions, created_at)
      VALUES (${value.id}, ${APP}, ${scope.runId}, ${JSON.stringify(value.conditions)}::jsonb,
        ${clock.now()})`.execute(h.db());
    if (value === older) clock.advanceMs(1000);
  }
  await store.recordDelivered(higher.id, [delivered('c2')]);
  await store.recordDelivered(lower.id, [delivered('c1')]);
  await store.recordDelivered(older.id, [delivered('c3')]);
  expect(await store.latestWithProducts(APP, scope.sessionId)).toEqual({
    ...higher,
    delivered: [delivered('c2')],
  });
});

// BR-AI-08 is explicitly requested by task §9 #4; no clarification/search logic is tested.
it('[AC-B3-09c#4][BR-AI-08] takeOnce 并发八次仅一胜者，重建实例仍去重，各维度独立', async () => {
  const stores = [h.store(), h.store()];
  const own = await h.scope();
  const scope = { appId: APP, sessionId: own.sessionId, chainId: 'synthetic-chain' };
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => stores[i % 2]!.takeOnce(scope, 'price')),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(results.filter((value) => value === false)).toHaveLength(7);
  expect(await h.store().takeOnce(scope, 'price')).toBe(false);
  expect(await stores[0]!.takeOnce(scope, 'price')).toBe(false);
  for (const slot of ['reference', 'platform'] as const) {
    expect(await h.store().takeOnce(scope, slot)).toBe(true);
    expect(await h.store().takeOnce(scope, slot)).toBe(false);
  }
  const otherSession = await h.scope();
  const otherApp = await h.scope(OTHER_APP);
  for (const changed of [
    { ...scope, chainId: 'synthetic-other-chain' },
    { ...scope, sessionId: otherSession.sessionId },
    { ...scope, appId: OTHER_APP, sessionId: otherApp.sessionId },
  ]) {
    expect(await h.store().takeOnce(changed, 'price')).toBe(true);
    expect(await h.store().takeOnce(changed, 'price')).toBe(false);
  }
  const rows = await sql`SELECT app_id, session_id, chain_id, slot FROM app.agent_clarify_asks
    WHERE app_id = ${APP} AND session_id = ${own.sessionId} AND chain_id = ${scope.chainId}
    ORDER BY slot`.execute(h.db());
  expect(rows.rows).toEqual(
    ['platform', 'price', 'reference'].map((slot) => ({
      app_id: APP,
      session_id: own.sessionId,
      chain_id: scope.chainId,
      slot,
    })),
  );
});
