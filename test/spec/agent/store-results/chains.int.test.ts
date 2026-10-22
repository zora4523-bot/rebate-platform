import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  createMemoryResultSetStore,
  type ResultSetStore,
  type SessionChain,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { expectChainPort } from '../orchestrator-results-chain/kit.ts';
import { APP, OTHER_APP, CONDITIONS, databaseKit, delivered, input } from './kit.ts';

const h = databaseKit();
// Same six transitions as B3-05k's frozen chain store tests.
const sequence: readonly SessionChain[] = [
  { chainId: 'synthetic-chain-z', status: 'searching', conditions: null },
  {
    chainId: 'synthetic-chain-z',
    status: 'awaiting_price',
    conditions: { q: '合成牛奶', chain_id: 'synthetic-chain-z' },
  },
  { chainId: 'synthetic-chain-z', status: 'has_products', conditions: CONDITIONS },
  { chainId: 'synthetic-chain-a', status: 'searching', conditions: null },
  { chainId: 'synthetic-chain-a', status: 'awaiting_price', conditions: null },
  {
    chainId: 'synthetic-chain-z',
    status: 'searching',
    conditions: { q: '合成后续查询', chain_id: 'synthetic-chain-z' },
  },
];

it('[AC-B3-09c#5][BR-AI-05] 七方法端口含链读写，未追加时不回落到已投递集', async () => {
  const store = h.store();
  expectChainPort(store);
  const scope = await h.scope();
  expect(await store.currentChain(APP, scope.sessionId)).toBeNull();
  const value = input(scope);
  await store.save(value);
  await store.recordDelivered(value.id, [delivered('c1')]);
  expect(await store.latestWithProducts(APP, scope.sessionId)).toEqual({
    ...value,
    delivered: [delivered('c1')],
  });
  expect(await store.currentChain(APP, scope.sessionId)).toBeNull();
  expect(await h.store().currentChain(APP, scope.sessionId)).toBeNull();
});

it('[AC-B3-09c#5][BR-AI-05] 六步链追加均保存历史，当前取最后追加值且重建实例可读', async () => {
  const store = h.store();
  const scope = await h.scope();
  for (const chain of sequence) {
    await store.appendChain(APP, scope.sessionId, chain);
    expect(await store.currentChain(APP, scope.sessionId)).toEqual(chain);
    expect(await h.store().currentChain(APP, scope.sessionId)).toEqual(chain);
  }
  const rows = await sql`SELECT seq, chain_id, status, conditions FROM app.agent_result_chains
    WHERE app_id = ${APP} AND session_id = ${scope.sessionId} ORDER BY seq`.execute(h.db());
  expect(rows.rows).toEqual(
    sequence.map((chain, index) => ({
      seq: index + 1,
      chain_id: chain.chainId,
      status: chain.status,
      conditions: chain.conditions,
    })),
  );
});

it('[AC-B3-09c#5][BR-AI-05] 当前链按 app 与会话隔离，异域追加互不覆盖', async () => {
  const store = h.store();
  const own = await h.scope();
  const otherSession = await h.scope();
  const otherApp = await h.scope(OTHER_APP);
  await store.appendChain(APP, own.sessionId, sequence[0]!);
  expect(await store.currentChain(OTHER_APP, own.sessionId)).toBeNull();
  expect(await store.currentChain(APP, otherSession.sessionId)).toBeNull();
  await store.appendChain(APP, otherSession.sessionId, sequence[1]!);
  await store.appendChain(OTHER_APP, otherApp.sessionId, sequence[2]!);
  expect(await h.store().currentChain(APP, own.sessionId)).toEqual(sequence[0]);
  expect(await h.store().currentChain(APP, otherSession.sessionId)).toEqual(sequence[1]);
  expect(await h.store().currentChain(OTHER_APP, otherApp.sessionId)).toEqual(sequence[2]);
  expect(await store.currentChain(APP, otherApp.sessionId)).toBeNull();
});

it.each<SessionChain>([
  { chainId: 'synthetic-invalid', status: 'has_products', conditions: null },
  ...(['has_products', 'searching', 'awaiting_price'] as const).map((status) => ({
    chainId: 'synthetic-invalid',
    status,
    conditions: { q: '合成牛奶', chain_id: 'synthetic-mismatch' },
  })),
])('[AC-B3-09c#6][BR-AI-05] 拒绝非法链 %j，不追加行且当前链不变', async (invalid) => {
  const store = h.store();
  const scope = await h.scope();
  const previous = sequence[2]!;
  await store.appendChain(APP, scope.sessionId, previous);
  const before = await sql`SELECT * FROM app.agent_result_chains
    WHERE app_id = ${APP} AND session_id = ${scope.sessionId} ORDER BY seq`.execute(h.db());
  await expect(store.appendChain(APP, scope.sessionId, invalid)).rejects.toThrow();
  expect(await store.currentChain(APP, scope.sessionId)).toEqual(previous);
  expect(
    (
      await sql`SELECT * FROM app.agent_result_chains
    WHERE app_id = ${APP} AND session_id = ${scope.sessionId} ORDER BY seq`.execute(h.db())
    ).rows,
  ).toEqual(before.rows);
});

it('[AC-B3-09c#6][BR-AI-05] 两实例并发追加全部成功，seq 连续且最大 seq 是当前链', async () => {
  const stores = [h.store(), h.store()];
  const scope = await h.scope();
  const chains: SessionChain[] = Array.from({ length: 8 }, (_, i) => ({
    chainId: `synthetic-concurrent-${i}`,
    status: 'searching',
    conditions: null,
  }));
  await Promise.all(
    chains.map((chain, i) => stores[i % 2]!.appendChain(APP, scope.sessionId, chain)),
  );
  const rows = (
    await sql<{ seq: number; chain_id: string; status: 'searching'; conditions: null }>`
    SELECT seq, chain_id, status, conditions FROM app.agent_result_chains
    WHERE app_id = ${APP} AND session_id = ${scope.sessionId} ORDER BY seq`.execute(h.db())
  ).rows;
  expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(rows.map((row) => row.chain_id).sort()).toEqual(
    chains.map((chain) => chain.chainId).sort(),
  );
  expect(rows.every((row) => row.status === 'searching' && row.conditions === null)).toBe(true);
  expect(await h.store().currentChain(APP, scope.sessionId)).toEqual({
    chainId: rows[7]!.chain_id,
    status: 'searching',
    conditions: null,
  });
});

it('[AC-B3-09c#7][BR-AI-05] 同一操作序列逐步比较 PG 与内存版全部读结果', async () => {
  const pg = h.store();
  const memory = createMemoryResultSetStore();
  const own = await h.scope();
  const foreign = await h.scope(OTHER_APP);
  const first = input(own);
  const second = input(await h.run(APP, own.sessionId));
  const empty = input(await h.run(APP, own.sessionId));
  const other = input(foreign);
  const scope = { appId: APP, sessionId: own.sessionId, chainId: 'synthetic-chain-z' };
  const operations: ((store: Required<ResultSetStore>) => Promise<unknown>)[] = [
    async () => undefined,
    (s) => s.save(first),
    (s) => s.recordDelivered(first.id, [delivered('c9'), delivered('c2')]),
    (s) => s.recordDelivered(first.id, [delivered('c9')]),
    (s) => s.save(second),
    (s) => s.recordDelivered(second.id, [delivered('c8')]),
    (s) => s.save(empty),
    (s) => s.save(other),
    (s) => s.recordDelivered(other.id, [delivered('c2')]),
    ...sequence.map(
      (chain) => (s: Required<ResultSetStore>) => s.appendChain(APP, own.sessionId, chain),
    ),
    (s) => s.takeOnce(scope, 'price'),
    (s) => s.takeOnce(scope, 'price'),
    (s) => s.takeOnce(scope, 'reference'),
  ];
  for (const operation of operations) {
    expect(await operation(pg)).toEqual(await operation(memory));
    for (const domain of [own, foreign, { ...own, appId: OTHER_APP }]) {
      expect(await pg.latestWithProducts(domain.appId, domain.sessionId)).toEqual(
        await memory.latestWithProducts(domain.appId, domain.sessionId),
      );
      expect(await pg.currentChain(domain.appId, domain.sessionId)).toEqual(
        await memory.currentChain(domain.appId, domain.sessionId),
      );
      for (const cardId of ['c2', 'c8', 'c9', 'c99']) {
        expect(await pg.findDelivered(domain.appId, domain.sessionId, cardId)).toEqual(
          await memory.findDelivered(domain.appId, domain.sessionId, cardId),
        );
      }
    }
  }
});
