// B3-03p §9 item 5 · BR-AI-18 on the production assembly: the body the stream runtime builds
// guards model text with the per-app output review, reading agent.safety.timeout_ms of each run's
// app from config_items (written after nothing was cached: per run). With the review request
// hanging, a run's sentence times out at that app's value, is reviewed once more before the run
// ends (another full value) and is replaced by agent.refuse.safety_timeout. Synthetic review
// transport (stream-review kit) and business ports (stream-assembly kit); scripted model.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createRunModelClock } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createProductionStreamAssembly,
  type AgentStreamProvidedPorts,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { contentReaderFor, fileText, setConfig, usePgEach } from '../stream-mount/kit.ts';
import { APP, fixture, passInput, request } from '../stream-assembly/kit.ts';
import { credentials, endpoint, transport } from '../stream-review/kit.ts';
import { receiptContext, scriptedModel, TIMEOUT_KEY } from '../stream-model-prereq/kit.ts';
import { flush, track, waitFor } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const OTHER_APP = 'synthetic-app-b';
const UNSET_APP = 'synthetic-app-unset';

it('[AC-B3-03p#21][BR-AI-18] 生产装配的输出按句审核按 run 的 app 读 agent.safety.timeout_ms：两个 app 各按本 app 的值超时、run 结束前再审一次后替换为 safety_timeout；未配置用 1000ms', async () => {
  const f = await fixture(pg.db);
  await setConfig(pg.db, APP, TIMEOUT_KEY, 2500);
  await setConfig(pg.db, OTHER_APP, TIMEOUT_KEY, 300);
  const ports: AgentStreamProvidedPorts = {
    platforms: f.deps.ports.search.platforms,
    searchProducts: f.deps.ports.search.searchProducts,
    readProduct: f.deps.ports.readProduct,
    parsing: f.deps.ports.parsing,
    cards: f.deps.ports.cards,
  };
  const wire = transport(['hang']);
  const assembly = createProductionStreamAssembly({
    db: pg.db,
    clock: f.time.clock,
    logger: f.logs.logger,
    scheduler: f.time.scheduler,
    contentReader: contentReaderFor(pg.db, f.time.clock),
    ports,
    safety: {
      appEnv: 'staging',
      credentials,
      endpoint,
      fetch: wire.fetch,
      nonce: () => 'synthetic-nonce',
    },
  });
  const body = vi.spyOn(core, 'createAgentRunBody');
  const r = f.mount(assembly);
  try {
    expect(body).toHaveBeenCalledTimes(1);
    const deps = body.mock.calls[0]![0];
    for (const [appId, budget] of [
      [APP, 2500],
      [OTHER_APP, 300],
      [UNSET_APP, 1000],
      [APP, 2500],
    ] as const) {
      const base = request(f.context(), '合成说明').input;
      const value = { ...base, caller: { ...base.caller, appId } };
      const out = receiptContext({ runId: value.runId, sessionId: value.sessionId });
      const sent = wire.calls.length;
      const start = f.time.t;
      const run = track(
        core.createAgentRunBody({
          ...deps,
          model: { complete: scriptedModel([{ text: '合成说明文字。' }]) },
          modelClock: () => createRunModelClock(60_000),
          prompt: { current: async () => ({ version: 'synthetic-v1', system: '合成系统前缀' }) },
          inputCheck: passInput,
        })(value)(out.ctx),
      );
      await waitFor(`${appId}: first sentence review`, () => wire.calls.length > sent);
      await flush();
      await f.time.to(start + budget - 1);
      expect(wire.calls.length, `${appId}: one review until ${String(budget - 1)} ms`).toBe(
        sent + 1,
      );
      expect(run.done, `${appId}: running at ${String(budget - 1)} ms`).toBe(false);
      await f.time.to(start + budget);
      await waitFor(
        `${appId}: reviewed again before the run ends`,
        () => wire.calls.length > sent + 1,
      );
      expect(run.done, `${appId}: running after the first timeout`).toBe(false);
      await f.time.to(start + 2 * budget - 1);
      expect(run.done, `${appId}: running at ${String(2 * budget - 1)} ms`).toBe(false);
      await f.time.to(start + 2 * budget);
      await waitFor(`${appId}: run ended`, () => run.done);
      expect(run.value, appId).toEqual({ kind: 'done', finishReason: 'stop' });
      expect(wire.calls.length, `${appId}: two reviews`).toBe(sent + 2);
      expect(out.texts.join(''), appId).toBe(fileText('agent.refuse.safety_timeout'));
    }
    expect(wire.unexpectedFetch).not.toHaveBeenCalled();
  } finally {
    await r.runtime.close();
  }
}, 120_000);
