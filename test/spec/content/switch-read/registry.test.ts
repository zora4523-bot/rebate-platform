// F1-10b: the emergency switch registry of 规划/04 §10.2 and its lookup. Readings in ./kit.ts.
// F1-02zm: #1 and #6 compare with expectedNow() (EXPECTED + the growth.invite_reward.* pair of
// F1-02zn), #7 looks rows up there too, and #15 pins that pair as the last two entries.
// F1-02zt：过渡已收紧, the pair must be present.
import { expect, it } from 'vitest';
import {
  switchRegistry,
  switchSpecOf,
  type SwitchPermission,
  type SwitchSpec,
} from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import { EXPECTED, INVITE_SW, NOT_SWITCHES, expectedNow, expectedOf } from './kit.ts';

function sorted<T>(items: readonly T[]): T[] {
  return [...items].sort();
}

function registered(pattern: string): SwitchSpec {
  const found = switchRegistry().filter((spec) => spec.pattern === pattern);
  expect(found).toHaveLength(1);
  const [spec] = found;
  if (spec === undefined) throw new Error(`not registered: ${pattern}`);
  return spec;
}

it('[AC-F1-10b#1] 04 §10.2、§9.2 (1)：注册表恰好收全 04 §10.2 每个键或键模式，不多不少不重复', () => {
  const patterns = switchRegistry().map((spec) => spec.pattern);
  expect(new Set(patterns).size).toBe(patterns.length);
  expect(sorted(patterns)).toStrictEqual(sorted(expectedNow().map((row) => row.pattern)));
});

it.each(EXPECTED.map((row) => [row.pattern, row] as const))(
  '[AC-F1-10b#2] 04 §10.2 值类型：%s',
  (pattern, row) => {
    const spec = registered(pattern);
    expect(spec.valueType.kind).toBe(row.valueType.kind);
    if (row.valueType.kind === 'enum') {
      expect(spec.valueType.kind === 'enum' ? sorted(spec.valueType.values) : null).toStrictEqual(
        sorted(row.valueType.values),
      );
    }
  },
);

it.each(EXPECTED.map((row) => [row.pattern, row] as const))(
  '[AC-F1-10b#3] 04 §10.2 默认列（on / off 不定记 null）：%s',
  (pattern, row) => {
    const spec = registered(pattern);
    expect(spec.defaultValue).toStrictEqual(row.defaultValue);
    expect({ ...spec.defaultOverrides }).toStrictEqual({ ...row.defaultOverrides });
    // A decided default must fit the value type; an object-typed switch has no decided default.
    for (const value of [spec.defaultValue, ...Object.values(spec.defaultOverrides)]) {
      if (spec.valueType.kind === 'object') expect(value).toBeNull();
      if (value === null) continue;
      if (spec.valueType.kind === 'boolean') expect(typeof value).toBe('boolean');
      if (spec.valueType.kind === 'enum') expect(spec.valueType.values).toContain(value);
    }
  },
);

it.each(EXPECTED.map((row) => [row.pattern, row] as const))(
  '[AC-F1-10b#4] 04 §11.2 逐键权限点：%s',
  (pattern, row) => {
    const spec = registered(pattern);
    expect(new Set(spec.permissions).size).toBe(spec.permissions.length);
    expect(sorted(spec.permissions)).toStrictEqual(sorted(row.permissions));
  },
);

it('[AC-F1-10b#5] 04 §11.2、BR-WDR-17：withdraw.enabled 为 switch.all+switch.payout，withdraw.auto_payout.enabled 只有 switch.all，pay.* 为 switch.all+switch.pay', () => {
  expect(sorted(registered('withdraw.enabled').permissions)).toStrictEqual([
    'switch.all',
    'switch.payout',
  ]);
  expect([...registered('withdraw.auto_payout.enabled').permissions]).toStrictEqual(['switch.all']);
  for (const key of [
    'pay.enabled',
    'pay.channel_enabled.wechat_pay',
    'pay.channel_enabled.alipay',
  ]) {
    expect(sorted(switchSpecOf(key)?.permissions ?? [])).toStrictEqual([
      'switch.all',
      'switch.pay',
    ]);
  }
});

it('[AC-F1-10b#6] 04 §11.2：switch.payout 只覆盖五个打款类键、switch.pay 只覆盖两个收款类键，二者互不包含，switch.all 覆盖全部', () => {
  const holders = (permission: SwitchPermission): string[] =>
    sorted(
      switchRegistry()
        .filter((spec) => spec.permissions.includes(permission))
        .map((spec) => spec.pattern),
    );
  expect(holders('switch.payout')).toStrictEqual(
    sorted([
      'withdraw.enabled',
      'payout.enabled',
      'payout.queue_paused',
      'payout.channel_enabled.<channel>',
      'payout.channel_paused.<channel>',
    ]),
  );
  expect(holders('switch.pay')).toStrictEqual(
    sorted(['pay.enabled', 'pay.channel_enabled.<pay_channel>']),
  );
  expect(holders('switch.all')).toStrictEqual(sorted(expectedNow().map((row) => row.pattern)));
  for (const spec of switchRegistry()) {
    expect(
      spec.permissions.includes('switch.payout') && spec.permissions.includes('switch.pay'),
    ).toBe(false);
  }
});

it('[AC-F1-10b#7] §9.2 (1)、BR-AI-12、BR-AI-21：只有 agent.whitelist_only 与 agent.model_route 标后台暂不可改', () => {
  const locked = switchRegistry()
    .filter((spec) => !spec.adminEditable)
    .map((spec) => spec.pattern);
  expect(sorted(locked)).toStrictEqual(['agent.model_route', 'agent.whitelist_only']);
  for (const spec of switchRegistry()) {
    expect(spec.adminEditable).toBe(expectedOf(spec.pattern).adminEditable);
  }
});

it('[AC-F1-10b#8] §9.2 (1)、BR-WDR-17、BR-FUND-19：payout.queue_paused、payout.channel_paused.<channel>、settle.auto.enabled 标系统也写入，其余不标', () => {
  const systemWritten = switchRegistry()
    .filter((spec) => spec.systemWritten)
    .map((spec) => spec.pattern);
  expect(sorted(systemWritten)).toStrictEqual(
    sorted(['payout.queue_paused', 'payout.channel_paused.<channel>', 'settle.auto.enabled']),
  );
});

it.each(EXPECTED.map((row) => [row.sample, row] as const))(
  '[AC-F1-10b#9] §9.2 (2)：具体键 %s 查到它的登记项，与注册表里的登记项相同',
  (key, row) => {
    const spec = switchSpecOf(key);
    expect(spec?.pattern).toBe(row.pattern);
    expect(spec).toStrictEqual(registered(row.pattern));
  },
);

it.each([
  ['convert.enabled.jd_union', 'convert.enabled.<platform>'],
  ['convert.enabled.pdd2', 'convert.enabled.<platform>'],
  ['convert.enabled.0', 'convert.enabled.<platform>'],
  ['convert.off_reason.taobao', 'convert.off_reason.<platform>'],
  ['search.enabled.taobao', 'search.enabled.<platform>'],
  ['agent.tools.x1.enabled', 'agent.tools.<name>.enabled'],
  ['agent.tools.search_products.enabled', 'agent.tools.<name>.enabled'],
  ['payout.channel_enabled.wechat', 'payout.channel_enabled.<channel>'],
  ['payout.channel_enabled.bank_card', 'payout.channel_enabled.<channel>'],
  ['payout.channel_enabled.future_channel', 'payout.channel_enabled.<channel>'],
  ['payout.channel_paused.alipay', 'payout.channel_paused.<channel>'],
  ['pay.channel_enabled.alipay', 'pay.channel_enabled.<pay_channel>'],
  ['credit.enabled.pdd', 'credit.enabled.<platform>'],
  ['watch.enabled.taobao', 'watch.enabled.<platform>'],
] as const)(
  '[AC-F1-10b#10] §9.2 (2) 占位符是一段小写字母数字下划线：%s 命中 %s',
  (key, pattern) => {
    expect(switchSpecOf(key)?.pattern).toBe(pattern);
  },
);

it.each(NOT_SWITCHES)(
  '[AC-F1-10b#11] §9.2 (2)、(4) 不是开关（不按前缀推、按段精确匹配）：%j（%s）',
  (key) => {
    expect(switchSpecOf(key)).toBeNull();
  },
);

it('[AC-F1-10b#12] BR-PROD-10：search.enabled.<platform> 与 convert.enabled.<platform> 是两个独立登记项，同平台互不代替', () => {
  const search = switchSpecOf('search.enabled.taobao');
  const convert = switchSpecOf('convert.enabled.taobao');
  expect(search?.pattern).toBe('search.enabled.<platform>');
  expect(convert?.pattern).toBe('convert.enabled.<platform>');
  expect(search?.defaultValue).toBeNull();
  expect(convert?.defaultValue).toBe(false);
});

it('[AC-F1-10b#13] 04 §10.2 按通道默认：payout.channel_enabled 支付宝 on、银行卡 off、微信 off，未列通道无定值', () => {
  const spec = switchSpecOf('payout.channel_enabled.alipay');
  expect(spec?.defaultOverrides['alipay']).toBe(true);
  expect(spec?.defaultOverrides['bank_card']).toBe(false);
  expect(spec?.defaultOverrides['wechat']).toBe(false);
  expect(spec?.defaultValue).toBeNull();
  expect(switchSpecOf('payout.channel_enabled.future_channel')?.defaultValue).toBeNull();
});

it('[AC-F1-10b#14] §9.2 (1) 纯数据：改动查询结果不影响之后的注册表与查询', () => {
  const before = structuredClone(switchRegistry());
  const list = switchRegistry() as SwitchSpec[];
  const target = switchSpecOf('withdraw.enabled') as {
    permissions: SwitchPermission[];
    defaultValue: unknown;
    adminEditable: boolean;
  } | null;
  expect(target).not.toBeNull();
  const attempts: (() => void)[] = [
    () => list.pop(),
    () => list.push(list[0] as SwitchSpec),
    () => target?.permissions.push('switch.pay'),
    () => {
      if (target !== null) target.defaultValue = false;
    },
    () => {
      if (target !== null) target.adminEditable = false;
    },
  ];
  for (const attempt of attempts) {
    try {
      attempt();
    } catch {
      // A frozen registry may refuse the change; either way nothing may change below.
    }
  }
  expect(structuredClone(switchRegistry())).toStrictEqual(before);
  expect(sorted(switchSpecOf('withdraw.enabled')?.permissions ?? [])).toStrictEqual([
    'switch.all',
    'switch.payout',
  ]);
  expect(switchSpecOf('withdraw.enabled')?.defaultValue).toBe(true);
});

// F1-02zm: the BR-INV-24 pair of F1-02zn is registered whole as the last two entries, after
// watch.enabled.<platform>. F1-02zt：过渡已收紧, the absent branch is gone.
it('[AC-F1-10b#15] BR-INV-24 ①④、04 §10.2、§11.2：growth.invite_reward.enabled 与 payout_paused 两个开关整组登记（注册表最后两项，布尔、默认 off、只认 switch.all、可改、非系统写）', () => {
  expect(INVITE_SW).toHaveLength(2);
  const patterns = switchRegistry().map((spec) => spec.pattern);
  const present = INVITE_SW.filter((row) => switchSpecOf(row.sample) !== null);
  expect(present).toHaveLength(INVITE_SW.length);
  const head = patterns.length - INVITE_SW.length;
  expect(patterns.slice(head)).toStrictEqual(INVITE_SW.map((row) => row.pattern));
  expect(patterns[head - 1]).toBe(EXPECTED.at(-1)!.pattern);
  for (const row of INVITE_SW) {
    const spec = registered(row.pattern);
    expect(switchSpecOf(row.sample)).toStrictEqual(spec);
    expect(spec.valueType).toStrictEqual({ kind: 'boolean' });
    expect(spec.defaultValue).toBe(false);
    expect({ ...spec.defaultOverrides }).toStrictEqual({});
    expect([...spec.permissions]).toStrictEqual(['switch.all']);
    expect(spec.adminEditable).toBe(true);
    expect(spec.systemWritten).toBe(false);
  }
});
