// B3-03n §9 item 4 · BR-AI-18 on the production assembly: createProductionStreamAssembly's input
// check reads agent.safety.timeout_ms of each request's app from config_items through content's
// configuration reader, per request (rows written after the assembly was built still apply).
// Synthetic review transport (stream-review kit) and synthetic business ports (stream-assembly kit).
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createProductionStreamAssembly,
  type AgentStreamProvidedPorts,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { setConfig, usePgEach } from '../stream-mount/kit.ts';
import { APP, fixture } from '../stream-assembly/kit.ts';
import { credentials, endpoint, transport } from '../stream-review/kit.ts';
import { expectInputBudget, TIMEOUT_KEY } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const OTHER_APP = 'synthetic-app-b';
const UNSET_APP = 'synthetic-app-unset';
const INVALID_APP = 'synthetic-app-invalid';

it('[AC-B3-03n#11][BR-AI-18] 生产装配经 content 配置读取口按 app 读 agent.safety.timeout_ms：两个 app 各自生效，未配置与非法值取 1000ms，每次请求按当前 app', async () => {
  const f = await fixture(pg.db);
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
    ports,
    safety: {
      appEnv: 'staging',
      credentials,
      endpoint,
      fetch: wire.fetch,
      nonce: () => 'synthetic-nonce',
    },
  });
  // Written after the build: the budget is read per request, never captured at build time.
  await setConfig(pg.db, APP, TIMEOUT_KEY, 2500);
  await setConfig(pg.db, OTHER_APP, TIMEOUT_KEY, 300);
  await setConfig(pg.db, INVALID_APP, TIMEOUT_KEY, 'not-a-number');
  const check = assembly.safety?.inputCheck;
  expect(check, 'production assembly has its safety ports').toBeDefined();
  for (const [appId, budget] of [
    [APP, 2500],
    [OTHER_APP, 300],
    [UNSET_APP, 1000],
    [INVALID_APP, 1000],
    [APP, 2500],
    [OTHER_APP, 300],
  ] as const) {
    await expectInputBudget(check!, wire, f.time, appId, budget);
  }
  expect(wire.unexpectedFetch).not.toHaveBeenCalled();
}, 120_000);
