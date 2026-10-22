import { expect, it, vi } from 'vitest';
import { createToolStatusDisplay, type ToolStatusTextsDeps } from './tool-status.ts';
import { agentTextIfPresent, platformDisplayName } from './texts.ts';

const NAMES: Record<string, string> = { taobao: '淘宝', jd: '京东', pdd: '拼多多' };

function setup(
  table: Record<string, string>,
  platforms: readonly string[] | Error = [],
): { display: ReturnType<typeof createToolStatusDisplay>; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const deps: ToolStatusTextsDeps = {
    text: (key) => table[key],
    searchPlatforms: async () => {
      if (platforms instanceof Error) throw platforms;
      return platforms;
    },
    platformName: (platform) => NAMES[platform],
    logger: { warn } as unknown as ToolStatusTextsDeps['logger'],
  };
  return { display: createToolStatusDisplay(deps), warn };
}

const FULL: Record<string, string> = {
  'agent.tool_status.default.start': '正在处理',
  'agent.tool_status.search_products.start': '正在查询商品',
  'agent.tool_status.search_products.start.jd': '正在查询京东商品',
  'agent.tool_status.get_rebate_quote.start': '正在查询返利',
};

it('[AC-B3-03j#tool-status-1] 带平台：平台键 → 工具键 → default 键', async () => {
  const { display } = setup(FULL);
  expect(await display('a', 'search_products', 'start', 'jd')).toBe('正在查询京东商品');
  expect(await display('a', 'search_products', 'start', 'pdd')).toBe('正在查询商品');
  expect(await display('a', 'other_tool', 'start', 'pdd')).toBe('正在处理');
});

it('[AC-B3-03j#tool-status-2] search_products 无平台、开着 ≥2 个：.multi 按固定顺序填平台名', async () => {
  const { display } = setup(
    { ...FULL, 'agent.tool_status.search_products.start.multi': '正在查询{platform_names}商品' },
    ['pdd', 'taobao', 'jd'],
  );
  expect(await display('a', 'search_products', 'start')).toBe('正在查询淘宝、京东、拼多多商品');
});

it('[AC-B3-03j#tool-status-3] .multi 键不存在时回落通用键，不显示键名', async () => {
  const { display, warn } = setup(FULL, ['taobao', 'jd']);
  expect(await display('a', 'search_products', 'start')).toBe('正在查询商品');
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B3-03j#tool-status-4] 只开 1 个平台按该平台取键；0 个或开关读失败用通用键', async () => {
  expect(await setup(FULL, ['jd']).display('a', 'search_products', 'start')).toBe(
    '正在查询京东商品',
  );
  expect(await setup(FULL, []).display('a', 'search_products', 'start')).toBe('正在查询商品');
  expect(await setup(FULL, new Error('x')).display('a', 'search_products', 'start')).toBe(
    '正在查询商品',
  );
});

it('[AC-B3-03j#tool-status-5] 其他工具：工具键 → default 键', async () => {
  const { display } = setup(FULL);
  expect(await display('a', 'get_rebate_quote', 'start')).toBe('正在查询返利');
  expect(await display('a', 'unknown_tool', 'start')).toBe('正在处理');
});

it('[AC-B3-03j#tool-status-6] 一个键都没有：记 warn，返回空串，不返回键名', async () => {
  const { display, warn } = setup({});
  expect(await display('a', 'get_rebate_quote', 'end')).toBe('');
  expect(warn).toHaveBeenCalledTimes(1);
});

it('[AC-B3-03j#tool-status-7] 生产文案来源：tool_status 键存在、平台名取自 apps.json', () => {
  expect(agentTextIfPresent('agent.tool_status.default.start')).toBeTypeOf('string');
  expect(agentTextIfPresent('agent.tool.search_products.start')).toBeUndefined();
  expect(platformDisplayName('taobao')).toBe('淘宝');
  expect(platformDisplayName('jd')).toBe('京东');
  expect(platformDisplayName('pdd')).toBe('拼多多');
});
