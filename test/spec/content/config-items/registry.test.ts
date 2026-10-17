// F1-10e ruling 14: the configuration item registry (content/domain, pure data, disjoint from the
// emergency switch registry). Oracle in ./kit.ts (EXPECTED) and the seed file itself.
import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
  type ConfigItemSpec,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  switchRegistry,
  switchSpecOf,
} from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import { EXPECTED, FUND_FLAGS, UNREGISTERED, jsonTypeOf, seedRows } from './kit.ts';

const sorted = <T>(items: readonly T[]): T[] => [...items].sort();
const EXTRA = ['agent.page_guide.routes', 'external_hosts'];

function registered(key: string): ConfigItemSpec {
  const found = configRegistry().filter((spec) => spec.key === key);
  expect(found, key).toHaveLength(1);
  return found[0]!;
}

it('[AC-F1-10e#1] 裁定 14：注册表恰好是种子里全部非开关键加 agent.page_guide.routes、external_hosts，不多不少不重复', () => {
  const keys = configRegistry().map((spec) => spec.key);
  expect(new Set(keys).size).toBe(keys.length);
  const seeds = [...seedRows().keys()];
  expect(seeds.length).toBeGreaterThan(0);
  const fromSeeds = seeds.filter((key) => switchSpecOf(key) === null);
  expect(sorted(keys)).toStrictEqual(sorted([...new Set([...fromSeeds, ...EXTRA])]));
  expect(sorted(keys)).toStrictEqual(sorted(EXPECTED.map((entry) => entry.key)));
});

it.each(EXPECTED.map((entry) => [entry.key, entry] as const))(
  '[AC-F1-10e#2] 裁定 14 逐键：%s 的值类型、权限点、可改标记，options 为 null',
  (key, entry) => {
    const spec = registered(key);
    expect({
      key: spec.key,
      valueType: spec.valueType,
      options: spec.options,
      permission: spec.permission,
      adminEditable: spec.adminEditable,
    }).toStrictEqual({ ...entry, options: null });
    expect(configItemSpecOf(key)).toStrictEqual(spec);
  },
);

it('[AC-F1-10e#3] 裁定 14：值类型取种子值的 JSON 类型（数组记 object）', () => {
  const seeds = seedRows();
  let checked = 0;
  for (const spec of configRegistry()) {
    if (!seeds.has(spec.key)) continue;
    expect(spec.valueType, spec.key).toBe(jsonTypeOf(seeds.get(spec.key)));
    checked += 1;
  }
  expect(checked).toBe(configRegistry().length - 1); // agent.page_guide.routes has no seed row
  expect(registered('agent.page_guide.routes').valueType).toBe('object');
});

it('[AC-F1-10e#4] 裁定 14：6 个资金规则标志与 agent.page_guide.routes、external_hosts 不可改，其余全部可改', () => {
  const locked = configRegistry()
    .filter((spec) => !spec.adminEditable)
    .map((spec) => spec.key);
  expect(sorted(locked)).toStrictEqual(sorted([...FUND_FLAGS, ...EXTRA]));
  for (const key of FUND_FLAGS) {
    expect(registered(key)).toMatchObject({ permission: 'config.business', adminEditable: false });
  }
});

it('[AC-F1-10e#5] 裁定 14、F1-10b：开关键不在配置中心，配置键也不是开关', () => {
  for (const spec of configRegistry()) expect(switchSpecOf(spec.key), spec.key).toBeNull();
  for (const sw of switchRegistry()) {
    const concrete = sw.pattern.replace(/<[a-z_]+>/g, 'taobao');
    expect(configItemSpecOf(concrete), concrete).toBeNull();
    expect(configItemSpecOf(sw.pattern), sw.pattern).toBeNull();
  }
});

it.each([
  ...UNREGISTERED,
  'ORDER.user_query_months',
  'order.user_query_months\n',
  ' order.user_query_months',
  'order.user_query_months.',
  'external_hosts.extra',
  'hasOwnProperty',
  '',
])('[AC-F1-10e#6] 裁定 14：注册表外的键 %j 查不到（不按前缀、不走原型链）', (key) => {
  expect(configItemSpecOf(key)).toBeNull();
  expect(configRegistry().some((spec) => spec.key === key)).toBe(false);
});

it('[AC-F1-10e#7] 注册表是共享的纯数据：改动返回值不影响后续查询', () => {
  const first = configRegistry();
  expect(Object.isFrozen(first)).toBe(true);
  for (const spec of first) expect(Object.isFrozen(spec), spec.key).toBe(true);
  try {
    (first[0] as { adminEditable: boolean }).adminEditable = !first[0]!.adminEditable;
  } catch {
    // strict-mode assignment to a frozen object throws; either way nothing may change
  }
  expect(configRegistry()[0]).toStrictEqual(first[0]);
  expect(registered(EXPECTED[0]!.key).adminEditable).toBe(EXPECTED[0]!.adminEditable);
});

it.each([
  ['boolean', true, true],
  ['boolean', false, true],
  ['boolean', 'true', false],
  ['boolean', 1, false],
  ['boolean', 0, false],
  ['boolean', null, false],
  ['boolean', [], false],
  ['number', 0, true],
  ['number', 1800, true],
  ['number', '3', false],
  ['number', true, false],
  ['number', null, false],
  ['number', {}, false],
  ['object', [], true],
  ['object', ['web_code'], true],
  ['object', {}, true],
  ['object', 'web_code', false],
  ['object', 1, false],
  ['object', true, false],
  ['object', null, false],
] as const)(
  '[AC-F1-10e#8] 裁定 9、14：%s 型的值 %j 合型=%s（null 一律不合）',
  (type, value, fits) => {
    const spec = configRegistry().find((entry) => entry.valueType === type && entry.adminEditable);
    expect(spec, type).toBeDefined();
    expect(configValueFits(spec!, value)).toBe(fits);
  },
);

it('[AC-F1-10e#9] enum 型（契约 AdminConfigValueType）只接受 options 里的字符串', () => {
  const spec: ConfigItemSpec = {
    key: 'x.mode',
    valueType: 'enum',
    options: ['a', 'b'],
    permission: 'config.general',
    adminEditable: true,
  };
  expect(configValueFits(spec, 'a')).toBe(true);
  expect(configValueFits(spec, 'b')).toBe(true);
  expect(configValueFits(spec, 'c')).toBe(false);
  expect(configValueFits(spec, 'A')).toBe(false);
  expect(configValueFits(spec, null)).toBe(false);
  expect(configValueFits(spec, ['a'])).toBe(false);
});
