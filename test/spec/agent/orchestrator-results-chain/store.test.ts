import { expect, it } from 'vitest';
import {
  createMemoryResultSetStore,
  type SessionChain,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { delivered, QUERY, expectChainPort } from './kit.ts';

it('[AC-B3-05k#6][BR-AI-05] 从未追加链返回 null，即使已有实际下发的结果集也不回落', async () => {
  const store = createMemoryResultSetStore();
  expectChainPort(store);
  expect(await store.currentChain('synthetic-app', 'synthetic-session')).toBeNull();
  await store.save({
    id: 'synthetic-delivered-set',
    appId: 'synthetic-app',
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    conditions: { q: QUERY, chain_id: 'synthetic-result-chain' },
  });
  await store.recordDelivered('synthetic-delivered-set', [delivered('c1')]);
  expect(await store.latestWithProducts('synthetic-app', 'synthetic-session')).not.toBeNull();
  expect(await store.currentChain('synthetic-app', 'synthetic-session')).toBeNull();
});

it('[AC-B3-05k#6][BR-AI-05][BR-AI-08] 三种状态均可追加，重复链与换链始终读取最后追加值', async () => {
  const store = createMemoryResultSetStore();
  expectChainPort(store);
  const sequence: readonly SessionChain[] = [
    { chainId: 'synthetic-chain-z', status: 'searching', conditions: null },
    {
      chainId: 'synthetic-chain-z',
      status: 'awaiting_price',
      conditions: { q: QUERY, chain_id: 'synthetic-chain-z' },
    },
    {
      chainId: 'synthetic-chain-z',
      status: 'has_products',
      conditions: { q: QUERY, price_max_fen: 5000, chain_id: 'synthetic-chain-z' },
    },
    { chainId: 'synthetic-chain-a', status: 'searching', conditions: null },
    { chainId: 'synthetic-chain-a', status: 'awaiting_price', conditions: null },
    {
      chainId: 'synthetic-chain-z',
      status: 'searching',
      conditions: { q: '合成后续查询', chain_id: 'synthetic-chain-z' },
    },
  ];
  for (const chain of sequence) {
    await store.appendChain('synthetic-app', 'synthetic-session', chain);
    expect(await store.currentChain('synthetic-app', 'synthetic-session')).toEqual(chain);
  }
});

it('[AC-B3-05k#6][BR-AI-05][BR-AI-08] app 和会话双维隔离，各自最近值互不覆盖且不跨 store', async () => {
  const store = createMemoryResultSetStore();
  expectChainPort(store);
  const first: SessionChain = {
    chainId: 'synthetic-chain-one',
    status: 'searching',
    conditions: null,
  };
  const second: SessionChain = {
    chainId: 'synthetic-chain-two',
    status: 'awaiting_price',
    conditions: null,
  };
  const third: SessionChain = {
    chainId: 'synthetic-chain-three',
    status: 'searching',
    conditions: null,
  };
  await store.appendChain('synthetic-app-one', 'synthetic-session-one', first);
  expect(await store.currentChain('synthetic-app-two', 'synthetic-session-one')).toBeNull();
  expect(await store.currentChain('synthetic-app-one', 'synthetic-session-two')).toBeNull();
  await store.appendChain('synthetic-app-two', 'synthetic-session-one', second);
  await store.appendChain('synthetic-app-one', 'synthetic-session-two', third);
  expect(await store.currentChain('synthetic-app-one', 'synthetic-session-one')).toEqual(first);
  expect(await store.currentChain('synthetic-app-two', 'synthetic-session-one')).toEqual(second);
  expect(await store.currentChain('synthetic-app-one', 'synthetic-session-two')).toEqual(third);
  expect(
    await createMemoryResultSetStore().currentChain('synthetic-app-one', 'synthetic-session-one'),
  ).toBeNull();
});

it.each<SessionChain>([
  { chainId: 'synthetic-invalid', status: 'has_products', conditions: null },
  {
    chainId: 'synthetic-invalid',
    status: 'has_products',
    conditions: { q: QUERY, chain_id: 'synthetic-other' },
  },
  {
    chainId: 'synthetic-invalid',
    status: 'searching',
    conditions: { q: QUERY, chain_id: 'synthetic-other' },
  },
  {
    chainId: 'synthetic-invalid',
    status: 'awaiting_price',
    conditions: { q: QUERY, chain_id: 'synthetic-other' },
  },
])(
  '[AC-B3-05k#6][BR-AI-05][BR-AI-08] 拒绝无条件商品链或条件链号不符 %j，原当前链不变',
  async (invalid) => {
    const store = createMemoryResultSetStore();
    expectChainPort(store);
    const previous: SessionChain = {
      chainId: 'synthetic-valid',
      status: 'has_products',
      conditions: { q: QUERY, price_max_fen: 5000, chain_id: 'synthetic-valid' },
    };
    await store.appendChain('synthetic-app', 'synthetic-session', previous);
    await expect(
      store.appendChain('synthetic-app', 'synthetic-session', invalid),
    ).rejects.toThrow();
    expect(await store.currentChain('synthetic-app', 'synthetic-session')).toEqual(previous);
  },
);
