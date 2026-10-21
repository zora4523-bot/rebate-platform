import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
  type ConfigItemSpec,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { EXPECTED, INVITE_CFG, inviteNow, presentOf } from '../config-items/kit.ts';
import { SETTLE } from './oracle.ts';

function registered(key: string): ConfigItemSpec {
  const found = configItemSpecOf(key);
  // Fail missing registration as an assertion, before calling configValueFits.
  expect(found, key).not.toBeNull();
  return found!;
}

it.each(SETTLE)('[AC-F1-02zj#1] BR-FUND-04：$key 的类型、选项、权限及整数范围', (expected) => {
  const actual = registered(expected.key);
  expect(actual).toStrictEqual(expected);
  expect(configRegistry().filter((entry) => entry.key === expected.key)).toStrictEqual([actual]);
});

it('[AC-F1-02zj#2] 16 项按裁定顺序追加；原 29 项及其无 range 行为保持不变', () => {
  const registry = configRegistry();
  // F1-02zv / F1-02zw: the CT-25 invite reward group inviteNow() (F1-02zn's five keys followed by
  // F1-02zx's growth.invite_reward.eligibility_days) follows SETTLE; nothing else may follow.
  // F1-02zt：过渡已收紧, the group must be present.
  presentOf(INVITE_CFG, 'growth.invite_reward.*');
  const invite = inviteNow();
  expect(registry.map((entry) => entry.key)).toStrictEqual([
    ...EXPECTED.map((entry) => entry.key),
    ...SETTLE.map((entry) => entry.key),
    ...invite.map((entry) => entry.key),
  ]);
  expect(registry.slice(0, 29)).toStrictEqual(
    EXPECTED.map((entry) => ({ ...entry, options: null })),
  );
  for (const expected of EXPECTED) {
    const spec = registered(expected.key);
    if (expected.valueType !== 'number') continue;
    // Extending number validation must not add business bounds or integer checks to old keys.
    for (const value of [-1, 0, 0.5, 24.5, 2147483648, Number.MAX_VALUE]) {
      expect(configValueFits(spec, value), `${spec.key}: ${value}`).toBe(true);
    }
    for (const value of [NaN, Infinity, -Infinity, '24', null, true, [], {}]) {
      expect(configValueFits(spec, value), spec.key).toBe(false);
    }
  }
});

it.each(SETTLE)('[AC-F1-02zj#3] $key 的共享登记、range 与 enum options 均冻结', (expected) => {
  const actual = registered(expected.key);
  expect(Object.isFrozen(configRegistry())).toBe(true);
  expect(Object.isFrozen(actual)).toBe(true);
  if (expected.range !== undefined) {
    const range: unknown = Reflect.get(actual, 'range');
    expect(range).toStrictEqual(expected.range);
    expect(Object.isFrozen(range)).toBe(true);
  }
  if (expected.options !== null) {
    expect(actual.options).toStrictEqual(expected.options);
    expect(Object.isFrozen(actual.options)).toBe(true);
  }
});

it.each(SETTLE.filter((entry) => entry.valueType === 'number'))(
  '[AC-F1-02zj#4] $key 拒绝非整数、类型转换和越界；接受闭区间两端',
  (expected) => {
    const spec = registered(expected.key);
    const { min, max } = expected.range!;
    for (const value of [min, min + 1, max - 1, max]) {
      expect(configValueFits(spec, value), `${spec.key}: ${value}`).toBe(true);
    }
    for (const value of [
      min - 1,
      max + 1,
      -1,
      min + 0.5,
      max - 0.5,
      NaN,
      Infinity,
      -Infinity,
      String(min),
      '24',
      null,
      undefined,
      true,
      false,
      [min],
      { value: min },
    ]) {
      expect(configValueFits(spec, value), `${spec.key}: ${String(value)}`).toBe(false);
    }
  },
);

it.each(SETTLE.filter((entry) => entry.valueType === 'enum'))(
  '[AC-F1-02zj#5] $key 仅接受对应的精确枚举字符串',
  (expected) => {
    const spec = registered(expected.key);
    for (const value of expected.options!) expect(configValueFits(spec, value)).toBe(true);
    const invalid = [
      'settled_at',
      'RECEIVED_AT',
      'API',
      'UPLOAD',
      '',
      ' api',
      'received_at\n',
      null,
      0,
      true,
      ['api'],
      { value: 'received_at' },
      ...(expected.options!.includes('api') ? ['received_at'] : ['api', 'upload']),
    ];
    for (const value of invalid) expect(configValueFits(spec, value), spec.key).toBe(false);
  },
);

it('[AC-F1-02zj#6] 仅登记四个平台的字面键；无后缀、错大小写及旧 wait_days 均查不到', () => {
  for (const platform of ['taobao', 'jd', 'pdd', 'meituan']) {
    expect(registered(`settle.period_basis.${platform}`).valueType).toBe('enum');
  }
  for (const key of [
    'settle.period_basis',
    'settle.period_basis.vip',
    'settle.period_basis.TAOBAO',
    'settle.period_basis.<platform>',
    'settle.period_basis.taobao.extra',
    'settle.statement_source.vip',
    'settle.period_offset_months.vip',
    'settle.bill_day.taobao',
    'settle.wait_days.taobao',
  ]) {
    expect(configItemSpecOf(key), key).toBeNull();
    expect(
      configRegistry().some((entry) => entry.key === key),
      key,
    ).toBe(false);
  }
});

it('[AC-F1-02zj#14] number 校验使用传入的 range；没有 range 时维持有限数语义', () => {
  // Structural typing keeps this red-stage test compilable before ConfigItemSpec gains range.
  const spec: ConfigItemSpec & {
    readonly range: { readonly integer: true; readonly min: number; readonly max: number };
  } = {
    key: 'test.number',
    valueType: 'number',
    options: null,
    permission: 'config.business',
    adminEditable: true,
    range: { integer: true, min: 2, max: 5 },
  };
  for (const value of [1, 6, 2.5]) expect(configValueFits(spec, value)).toBe(false);
  for (const value of [2, 3, 5]) expect(configValueFits(spec, value)).toBe(true);
  const withoutRange: ConfigItemSpec = {
    key: spec.key,
    valueType: spec.valueType,
    options: null,
    permission: spec.permission,
    adminEditable: true,
  };
  for (const value of [-1, 2.5, 2147483648]) {
    expect(configValueFits(withoutRange, value)).toBe(true);
  }
});
