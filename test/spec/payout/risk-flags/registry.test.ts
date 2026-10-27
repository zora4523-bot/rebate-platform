// B2-11a 9.3 #6: the six BR-WDR-29 thresholds are configuration items the console changes (BR-WDR-17:
// with permission and step-up), under 规划/04 §11.2 `config.risk` (风控规则与阈值). Integer bp /
// counts: a default must fit, a negative, fractional or non-number value must not.
import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { switchSpecOf } from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';

// The six keys and their defaults (BR-WDR-29; D10-368, as registered by B2-11z), written out here
// so this file needs nothing of the task's code (D10-383: it lands on main ahead of B2-11a).
const KEYS = {
  invalid_ratio_bp: 'risk.withdraw.invalid_ratio_bp',
  invalid_min_count: 'risk.withdraw.invalid_min_count',
  high_commission_rate_bp: 'risk.withdraw.high_commission_rate_bp',
  high_commission_ratio_bp: 'risk.withdraw.high_commission_ratio_bp',
  min_orders: 'risk.withdraw.min_orders',
  withdraw_received_ratio_bp: 'risk.withdraw.withdraw_received_ratio_bp',
} as const;
type ThresholdName = keyof typeof KEYS;
const DEFAULTS: Readonly<Record<ThresholdName, number>> = {
  invalid_ratio_bp: 3000,
  invalid_min_count: 3,
  high_commission_rate_bp: 5000,
  high_commission_ratio_bp: 5000,
  min_orders: 5,
  withdraw_received_ratio_bp: 10000,
};

const NAMES = Object.keys(KEYS) as ThresholdName[];

it.each(NAMES)('[AC-B2-11a#8] %s 登记为可改的 config.risk 整数配置项，默认值可存', (name) => {
  const key = KEYS[name];
  const spec = configItemSpecOf(key);
  expect(spec, `${key} 必须先登记`).not.toBeNull();
  expect(spec).toMatchObject({
    key,
    valueType: 'number',
    options: null,
    permission: 'config.risk',
    adminEditable: true,
  });
  expect(configRegistry().filter((entry) => entry.key === key)).toHaveLength(1);
  expect(switchSpecOf(key)).toBeNull();
  expect(configValueFits(spec!, DEFAULTS[name])).toBe(true);
});

it.each(NAMES)('[AC-B2-11a#9] %s 拒绝负数、小数与非数值', (name) => {
  const key = KEYS[name];
  const spec = configItemSpecOf(key);
  expect(spec, `${key} 必须先登记；避免把 null 传入校验器`).not.toBeNull();
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3000', null, true, [], {}]) {
    expect(configValueFits(spec!, value), `${key}: ${String(value)}`).toBe(false);
  }
});
