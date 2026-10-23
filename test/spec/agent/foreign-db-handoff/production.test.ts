// B3-08k · BR-AI-02 ③ (D10-294): createProductionStreamAssembly reads its configuration through
// the content reader app.module assembled (context.contentReader), never through a reader built
// from context.db. content's createContentReader and agent's createAgentStreamAssembly are
// wrapped by vi.mock (both still run as they are): the first counts the readers built, the second
// keeps the deps the production assembly hands over (its page_guide routes port). The database is
// compile-only (DummyDriver): a config_items query means a reader over agent's handle.
import { expect, it, vi } from 'vitest';

import {
  createProductionStreamAssembly,
  type AgentStreamAssemblyContext,
  type AgentStreamAssemblyDeps,
  type AgentStreamProvidedPorts,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import { APP, FakeContentReader, compileOnlyDb, configQueries, fixedClock, logs } from './kit.ts';

const seen = vi.hoisted(() => ({
  contentReaders: 0,
  assemblies: [] as AgentStreamAssemblyDeps[],
}));

vi.mock('../../../../apps/api/src/modules/content/index.ts', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../../apps/api/src/modules/content/index.ts')>();
  return {
    ...original,
    createContentReader: (options: Parameters<typeof original.createContentReader>[0]) => {
      seen.contentReaders += 1;
      return original.createContentReader(options);
    },
  };
});

vi.mock(
  '../../../../apps/api/src/modules/agent/stream/mount/assembly.ts',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('../../../../apps/api/src/modules/agent/stream/mount/assembly.ts')
      >();
    return {
      ...original,
      createAgentStreamAssembly: (deps: AgentStreamAssemblyDeps) => {
        seen.assemblies.push(deps);
        return original.createAgentStreamAssembly(deps);
      },
    };
  },
);

const ROUTES = 'agent.page_guide.routes';

function productionContext(reader: FakeContentReader) {
  const queries: string[] = [];
  const ports: AgentStreamProvidedPorts = {
    platforms: ['taobao', 'jd'],
    searchProducts: vi.fn<AgentStreamProvidedPorts['searchProducts']>(),
    readProduct: vi.fn<AgentStreamProvidedPorts['readProduct']>(),
    // Never reached: no link is parsed in these tests.
    parsing: {} as AgentStreamProvidedPorts['parsing'],
    cards: vi.fn<AgentStreamProvidedPorts['cards']>(),
  };
  const context: AgentStreamAssemblyContext = {
    db: compileOnlyDb(queries),
    clock: fixedClock(),
    logger: logs().logger,
    ports,
    contentReader: reader,
  };
  return { context, queries };
}

it('[AC-B3-08k#2][BR-AI-02] createProductionStreamAssembly：搜索平台开关 search.enabled.<platform> 经注入的 content 读取器（context.contentReader）读取，只认显式 true；装配不调用 content 的 createContentReader、不发 config_items 查询', async () => {
  seen.contentReaders = 0;
  const reader = new FakeContentReader()
    .set(APP, 'search.enabled.taobao', true)
    .set(APP, 'search.enabled.jd', false)
    .set('other', 'search.enabled.taobao', 'yes')
    .set('other', 'search.enabled.jd', true);
  const { context, queries } = productionContext(reader);
  const assembly = createProductionStreamAssembly(context);
  expect(seen.contentReaders, 'content readers built by the assembly').toBe(0);

  const platforms = await assembly.tools.enabledSearchPlatforms(APP);
  expect(reader.keys('configValue')).toEqual(
    expect.arrayContaining(['search.enabled.taobao', 'search.enabled.jd']),
  );
  expect(platforms).toEqual(['taobao']);
  // BR-PROD-10: explicit true only ('yes' is off); a missing key is off.
  expect(await assembly.tools.enabledSearchPlatforms('other')).toEqual(['jd']);
  expect(await assembly.tools.enabledSearchPlatforms('missing-app')).toEqual([]);
  expect(reader.keys('freshConfigValue', APP)).toEqual([]);
  expect(configQueries(queries)).toEqual([]);
  expect(seen.contentReaders).toBe(0);
});

it('[AC-B3-08k#2][BR-AI-01][BR-AI-02] 页面引导路由 agent.page_guide.routes 经注入的 content 读取器读取：数组只留字符串项；非数组、缺失或读取失败 → []；不发 config_items 查询', async () => {
  seen.contentReaders = 0;
  seen.assemblies.length = 0;
  const reader = new FakeContentReader()
    .set(APP, ROUTES, ['Wallet', 7, 'Orders'])
    .set('scalar-app', ROUTES, 'Wallet')
    .fail('failing-app', ROUTES);
  const { context, queries } = productionContext(reader);
  createProductionStreamAssembly(context);
  expect(seen.contentReaders, 'content readers built by the assembly').toBe(0);
  expect(seen.assemblies).toHaveLength(1);
  const routes = seen.assemblies[0]!.routes;

  expect(await routes.configured(APP)).toEqual(['Wallet', 'Orders']);
  expect(reader.count('configValue', APP, ROUTES)).toBeGreaterThan(0);
  expect(await routes.configured('scalar-app')).toEqual([]);
  expect(await routes.configured('missing-app')).toEqual([]);
  expect(await routes.configured('failing-app')).toEqual([]);
  expect(reader.count('configValue', 'failing-app', ROUTES)).toBeGreaterThan(0);
  expect(configQueries(queries)).toEqual([]);
});
