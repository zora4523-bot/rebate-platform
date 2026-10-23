// B3-03n §9 item 2 · BR-AI-05: the production result store is agent/store/results'
// createPgResultSetStore (B3-09c), shared by every stream runtime instance; createAgentStreamAssembly
// uses an injected store and still falls back to createMemoryResultSetStore() when given only its
// original deps (B3-03f / B3-03j / B3-03m callers). Real runtime + PG; synthetic DTOs only.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeliveredProduct } from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { createPgResultSetStore } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import {
  createAgentStreamAssembly,
  createAgentStreamRuntime,
  createProductionStreamAssembly,
  type AgentStreamAssembly,
  type AgentStreamAssemblyFactory,
  type AgentStreamProvidedPorts,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { framesOf, message, openSession, send, usePgEach } from '../stream-mount/kit.ts';
import { APP, fixture, passInput } from '../stream-assembly/kit.ts';
import { callTool } from '../stream-assembly/regression-kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

function delivery(resultSetId: string, cardId: string): DeliveredProduct {
  return {
    card_id: cardId,
    product_key: 'tb:synthetic-cup',
    platform: 'taobao',
    final_price_fen: 10000,
    card: {
      type: 'product_list',
      schema_version: 1,
      data: { result_set_id: resultSetId, items: [], layout: 'list' },
      fallback_text: '合成商品列表',
    },
  };
}

/** One run of the session through `runtime` (the result set must belong to a real run). */
async function runOf(
  r: Parameters<typeof send>[0],
  caller: Parameters<typeof send>[1],
  sessionId: string,
): Promise<string> {
  framesOf((await send(r, caller, sessionId, message('钱包在哪'))).chunks);
  const runs = await pg.db
    .selectFrom('agent_runs')
    .select('id')
    .where('session_id', '=', sessionId)
    .execute();
  expect(runs).toHaveLength(1);
  return runs[0]!.id;
}

it('[AC-B3-03n#3][BR-AI-05] 生产装配的结果集是 PG 版：两个 stream runtime 实例之间读到同一结果集与出卡回执，报价引用跨实例解析', async () => {
  const f = await fixture(pg.db);
  const ports: AgentStreamProvidedPorts = {
    platforms: f.deps.ports.search.platforms,
    searchProducts: f.deps.ports.search.searchProducts,
    readProduct: f.deps.ports.readProduct,
    parsing: f.deps.ports.parsing,
    cards: f.deps.ports.cards,
  };
  const built: AgentStreamAssembly[] = [];
  const factory: AgentStreamAssemblyFactory = (context) => {
    const assembly = createProductionStreamAssembly({ ...context, ports });
    built.push(assembly);
    return assembly;
  };
  const make = () =>
    createAgentStreamRuntime(
      {
        db: pg.db,
        clock: f.time.clock,
        logger: f.logs.logger,
        consentReader: f.consentReader,
        assembly: factory,
      },
      { inputCheck: passInput, schedule: f.time.scheduler },
    );
  const first = make();
  const second = make();
  try {
    expect(built).toHaveLength(2);
    const [writer, reader] = built as [AgentStreamAssembly, AgentStreamAssembly];
    const r = { runtime: first, time: f.time, logs: f.logs };
    const sessionId = await openSession(r, f.caller);
    const runId = await runOf(r, f.caller, sessionId);
    const id = randomUUID();
    await writer.results.save({
      id,
      appId: APP,
      sessionId,
      runId,
      conditions: { q: '保温杯', chain_id: 'synthetic-chain' },
    });
    await writer.results.recordDelivered(id, [delivery(id, 'c41')]);

    const latest = await reader.results.latestWithProducts(APP, sessionId);
    expect(latest, 'the other instance reads the same result set').not.toBeNull();
    expect(latest).toMatchObject({
      id,
      appId: APP,
      sessionId,
      runId,
      conditions: { q: '保温杯', chain_id: 'synthetic-chain' },
      delivered: [
        expect.objectContaining({
          card_id: 'c41',
          product_key: 'tb:synthetic-cup',
          final_price_fen: 10000,
        }),
      ],
    });
    expect(await reader.results.findDelivered(APP, sessionId, 'c41')).toMatchObject({
      product_key: 'tb:synthetic-cup',
      platform: 'taobao',
    });
    expect(await reader.results.findDelivered('another-app', sessionId, 'c41')).toBeNull();
    // Persisted: conditions in agent_result_sets, the receipt in agent_result_deliveries.
    expect(
      await pg.db.selectFrom('agent_result_sets').select('run_id').where('id', '=', id).execute(),
    ).toEqual([{ run_id: runId }]);
    expect(
      await pg.db
        .selectFrom('agent_result_deliveries')
        .select(['card_id', 'product_key'])
        .where('result_set_id', '=', id)
        .execute(),
    ).toEqual([{ card_id: 'c41', product_key: 'tb:synthetic-cup' }]);

    // The other instance's quote tool resolves the reference through the same store.
    const outcome = await callTool(reader.tools, f.context(sessionId), 'get_rebate_quote', {
      card_id: 'c41',
    });
    expect(outcome.kind).toBe('ok');
    expect(f.readProduct).toHaveBeenCalledWith('tb:synthetic-cup', expect.anything());
  } finally {
    await first.close();
    await second.close();
  }
}, 120_000);

it('[AC-B3-03n#4][BR-AI-05] createAgentStreamAssembly 使用注入的结果集（PG 版跨装配共享）；只传原有 deps 时回落内存版且照常可用', async () => {
  const f = await fixture(pg.db);
  const r = f.mount(f.build());
  try {
    const sessionId = await openSession(r, f.caller);
    const runId = await runOf(r, f.caller, sessionId);

    const writer = createAgentStreamAssembly({
      ...f.deps,
      results: createPgResultSetStore({ db: pg.db }),
    });
    const reader = createAgentStreamAssembly({
      ...f.deps,
      results: createPgResultSetStore({ db: pg.db }),
    });
    const id = randomUUID();
    await writer.results.save({
      id,
      appId: APP,
      sessionId,
      runId,
      conditions: { q: '保温杯', chain_id: 'synthetic-chain' },
    });
    await writer.results.recordDelivered(id, [delivery(id, 'c41')]);
    const shared = await reader.results.findDelivered(APP, sessionId, 'c41');
    expect(shared, 'the injected store is the one the assembly uses').not.toBeNull();
    expect(shared).toMatchObject({ card_id: 'c41', product_key: 'tb:synthetic-cup' });
    const quoted = await callTool(reader.tools, f.context(sessionId), 'get_rebate_quote', {
      card_id: 'c41',
    });
    expect(quoted.kind).toBe('ok');

    // Original deps only: one in-memory store per assembly, nothing persisted, no run check.
    const legacy = createAgentStreamAssembly(f.deps);
    const other = createAgentStreamAssembly(f.deps);
    const memoryId = randomUUID();
    await legacy.results.save({
      id: memoryId,
      appId: APP,
      sessionId,
      runId: randomUUID(),
      conditions: { q: '保温杯', chain_id: 'synthetic-memory-chain' },
    });
    await legacy.results.recordDelivered(memoryId, [delivery(memoryId, 'c42')]);
    expect(await legacy.results.findDelivered(APP, sessionId, 'c42')).toMatchObject({
      card_id: 'c42',
    });
    expect(await other.results.findDelivered(APP, sessionId, 'c42')).toBeNull();
    expect(
      await pg.db.selectFrom('agent_result_sets').select('id').where('id', '=', memoryId).execute(),
    ).toEqual([]);
  } finally {
    await r.runtime.close();
  }
}, 120_000);
