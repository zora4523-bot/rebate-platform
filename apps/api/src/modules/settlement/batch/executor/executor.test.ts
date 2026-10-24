// 单元测试（不连库）：settle.auto.enabled 没有存储值时取开关登记表的默认值（on）。
import { expect, it } from 'vitest';
import { autoSwitchValue } from './executor.ts';
import { switchOn } from './rules.ts';

it('[AC-B2-04p-UNIT#4] settle.auto.enabled 未配置（undefined / null）按登记表默认 on；显式 off 仍为 off', () => {
  expect(switchOn(autoSwitchValue(undefined))).toBe(true);
  expect(switchOn(autoSwitchValue(null))).toBe(true);
  expect(switchOn(autoSwitchValue(true))).toBe(true);
  expect(switchOn(autoSwitchValue('on'))).toBe(true);
  expect(switchOn(autoSwitchValue(false))).toBe(false);
  expect(switchOn(autoSwitchValue('off'))).toBe(false);
});

it('[AC-B2-04p-UNIT#5] credit.enabled.<platform> 不走默认：未配置即 off（BR-CALC-03）', () => {
  expect(switchOn(undefined)).toBe(false);
  expect(switchOn(null)).toBe(false);
});
