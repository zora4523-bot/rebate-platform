// F1-10e ruling 14: the configuration item registry (content/domain, pure data, disjoint from the
// emergency switch registry). Oracle in ./kit.ts (EXPECTED) and the seed file itself.
// F1-02zi / F1-02zm / F1-02zw: #1 compares with expectedNow() (EXPECTED + the BR-FUND-04 settle.*
// group of F1-02zj + the BR-INV-24 growth.invite_reward.* group of F1-02zn / F1-02zx), #3 reads an
// enum item's seed as a JSON string, #56 pins SETTLE, #57 the five invite reward keys and #58
// growth.invite_reward.eligibility_days as the last item. F1-02zt：过渡已收紧, every group present.
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
import {
  EXPECTED,
  FUND_FLAGS,
  INVITE_CFG,
  INVITE_ELIG,
  SETTLE,
  UNREGISTERED,
  expectedNow,
  inviteNow,
  jsonTypeOf,
  presentOf,
  seedRows,
} from './kit.ts';

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
  // F1-02zt：过渡已收紧: EXPECTED + settle.* + growth.invite_reward.*, all present.
  expect(sorted(keys)).toStrictEqual(sorted(expectedNow().map((entry) => entry.key)));
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
    // F1-02zi: an enum item's seed is a JSON string (EXPECTED has no enum).
    const seedType = spec.valueType === 'enum' ? 'string' : spec.valueType;
    expect(seedType, spec.key).toBe(jsonTypeOf(seeds.get(spec.key)));
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

// F1-02zi: the BR-FUND-04 细则 settle.* group of F1-02zj is registered whole, after the ruling 14
// items and in its own order. F1-02zt：过渡已收紧, the absent branch is gone.
it('[AC-F1-10e#56] BR-FUND-04 细则 settle.* 一组 16 键整组登记（追加在裁定 14 之后，逐键值类型、options、权限点、可改标记）', () => {
  expect(SETTLE).toHaveLength(16);
  const keys = configRegistry().map((spec) => spec.key);
  const present = SETTLE.filter((entry) => keys.includes(entry.key));
  expect(present).toHaveLength(SETTLE.length);
  // F1-02zm / F1-02zw: the only keys after this group are the whole growth.invite_reward.* group
  // inviteNow() (checked key by key in #57 and #58).
  presentOf(INVITE_CFG, 'growth.invite_reward.*');
  const inviteTail = inviteNow().map((e) => e.key);
  expect(keys.slice(EXPECTED.length, EXPECTED.length + SETTLE.length)).toStrictEqual(
    SETTLE.map((entry) => entry.key),
  );
  expect(keys.slice(EXPECTED.length + SETTLE.length)).toStrictEqual(inviteTail);
  for (const entry of SETTLE) {
    const spec = registered(entry.key);
    expect({
      key: spec.key,
      valueType: spec.valueType,
      options: spec.options,
      permission: spec.permission,
      adminEditable: spec.adminEditable,
    }).toStrictEqual({ ...entry, options: entry.options ?? null });
    expect(configItemSpecOf(entry.key), entry.key).toBe(spec);
  }
});

// F1-02zm: the BR-INV-24 细则 growth.invite_reward.* group of F1-02zn is registered whole right
// after SETTLE, in its own order, followed only by eligibility_days (#58). F1-02zt：过渡已收紧, the
// absent branch is gone.
it('[AC-F1-10e#57] BR-INV-24 细则 growth.invite_reward.* 一组 5 键整组登记（紧接 settle.* 之后、其后只有 eligibility_days，逐键值类型、options、权限点、可改标记）', () => {
  expect(INVITE_CFG).toHaveLength(5);
  const keys = configRegistry().map((spec) => spec.key);
  const present = INVITE_CFG.filter((entry) => keys.includes(entry.key));
  expect(present).toHaveLength(INVITE_CFG.length);
  // F1-02zw: the tail is inviteNow(), the five keys followed by eligibility_days (checked in #58).
  const tail = inviteNow();
  const head = keys.length - tail.length;
  expect(keys.slice(head)).toStrictEqual(tail.map((entry) => entry.key));
  expect(keys.slice(head, head + INVITE_CFG.length)).toStrictEqual(
    INVITE_CFG.map((entry) => entry.key),
  );
  presentOf(SETTLE, 'settle.*');
  expect(keys[head - 1]).toBe(SETTLE.at(-1)!.key);
  for (const entry of INVITE_CFG) {
    const spec = registered(entry.key);
    expect({
      key: spec.key,
      valueType: spec.valueType,
      options: spec.options,
      permission: spec.permission,
      adminEditable: spec.adminEditable,
    }).toStrictEqual({ ...entry, options: null });
    expect(configItemSpecOf(entry.key), entry.key).toBe(spec);
  }
});

// F1-02zw: the BR-INV-24 细则 eligibility period of F1-02zx (08 l.560; 04 §10.1, config.business)
// is registered as the last item, right after growth.invite_reward.ip_window_hours.
// F1-02zt：过渡已收紧, the absent branch is gone.
it('[AC-F1-10e#58] BR-INV-24 细则 growth.invite_reward.eligibility_days 登记为注册表最后一项（紧接 ip_window_hours，数值、options 为 null、config.business、可改）', () => {
  expect(INVITE_ELIG).toHaveLength(1);
  const key = 'growth.invite_reward.eligibility_days';
  expect(INVITE_ELIG[0]!.key).toBe(key);
  const keys = configRegistry().map((spec) => spec.key);
  const tail = inviteNow().map((entry) => entry.key);
  expect(tail).toStrictEqual([...INVITE_CFG.map((entry) => entry.key), key]);
  expect(keys.filter((entry) => entry === key)).toHaveLength(1);
  expect(keys.at(-1)).toBe(key);
  expect(keys.at(-2)).toBe('growth.invite_reward.ip_window_hours');
  const spec = registered(key);
  expect({
    key: spec.key,
    valueType: spec.valueType,
    options: spec.options,
    permission: spec.permission,
    adminEditable: spec.adminEditable,
  }).toStrictEqual({
    key,
    valueType: 'number',
    options: null,
    permission: 'config.business',
    adminEditable: true,
  });
  expect(configItemSpecOf(key)).toBe(spec);
  expect(switchSpecOf(key)).toBeNull();
});
