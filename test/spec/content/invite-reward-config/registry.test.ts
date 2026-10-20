import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  switchRegistry,
  switchSpecOf,
} from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import { CONFIGS, ENABLED, PAUSED } from './oracle.ts';

it.each(CONFIGS)('[AC-F1-02zn#1] $key：类型、权限、可编辑性与整数范围', (row) => {
  expect(configItemSpecOf(row.key)).toStrictEqual({
    key: row.key,
    valueType: 'number',
    options: null,
    permission: row.permission,
    adminEditable: true,
    range: { integer: true, min: row.min, max: 2147483647 },
  });
  expect(configRegistry().filter((entry) => entry.key === row.key)).toHaveLength(1);
  expect(switchSpecOf(row.key)).toBeNull();
});

it('[AC-F1-02zn#2] 五项按指定顺序追加在 SETTLE 之后', () => {
  expect(
    configRegistry()
      .slice(-6)
      .map((entry) => entry.key),
  ).toStrictEqual(['settle.statement.grace_days', ...CONFIGS.map((row) => row.key)]);
});

it.each(CONFIGS)('[AC-F1-02zn#3] $key：闭区间、默认值、拒绝浮点与隐式转换', (row) => {
  const spec = configItemSpecOf(row.key);
  expect(spec, row.key).not.toBeNull();
  for (const value of [row.min, row.min + 1, row.seed, 1000, 2147483647]) {
    expect(configValueFits(spec!, value), String(value)).toBe(true);
  }
  for (const value of [
    row.min - 1,
    -1,
    2147483648,
    10.5,
    NaN,
    Infinity,
    -Infinity,
    '1000',
    '24',
    null,
    undefined,
    true,
    false,
    [],
    {},
  ]) {
    expect(configValueFits(spec!, value), String(value)).toBe(false);
  }
});

it.each([ENABLED, PAUSED])('[AC-F1-02zn#4] %s：默认 off、switch.all、可改且非系统写', (key) => {
  expect(switchSpecOf(key)).toStrictEqual({
    pattern: key,
    valueType: { kind: 'boolean' },
    defaultValue: false,
    defaultOverrides: {},
    permissions: ['switch.all'],
    adminEditable: true,
    systemWritten: false,
  });
  expect(configItemSpecOf(key)).toBeNull();
  expect(switchRegistry().filter((entry) => entry.pattern === key)).toHaveLength(1);
});

it('[AC-F1-02zn#5] 两个开关按顺序追加在 watch.enabled.<platform> 之后', () => {
  expect(
    switchRegistry()
      .slice(-3)
      .map((entry) => entry.pattern),
  ).toStrictEqual(['watch.enabled.<platform>', ENABLED, PAUSED]);
});
