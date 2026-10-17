// F1-10d: the pure checks behind the kill switch admin routes (apps/api/src/modules/content/
// domain/kill-switch.ts), against the frozen F1-10b registry oracle. Readings in ./kit.ts.
import { expect, it } from 'vitest';
import {
  killSwitchChangeRefusal,
  killSwitchDescriptor,
} from '../../../../apps/api/src/modules/content/domain/kill-switch.ts';
import { EXPECTED, NOT_SWITCHES, staticFields } from './oracle.ts';

const BOOLEAN_INVALID: readonly unknown[] = ['true', 'false', 'on', 1, 0, null, {}, [], [true]];
const ENUM_INVALID: readonly unknown[] = [
  'MAINTENANCE',
  ' maintenance',
  'paused',
  '',
  true,
  1,
  null,
  {},
  ['maintenance'],
];

/** Further concrete keys that show per-placeholder defaults (04 §10.2). */
const CONCRETE: readonly string[] = [
  'payout.channel_enabled.alipay',
  'payout.channel_enabled.bank_card',
  'payout.channel_enabled.wechat',
  'payout.channel_enabled.unionpay',
  'convert.enabled.pdd',
  'convert.off_reason.taobao',
  'search.enabled.taobao',
  'agent.tools.search_products.enabled',
  'pay.channel_enabled.alipay',
  'watch.enabled.jd',
];

it.each([...EXPECTED.map((row) => row.sample), ...CONCRETE])(
  '[AC-F1-10d#27] §9.2 #1 列表的登记信息：%s 的默认值（含按占位值的覆盖）、类型、可选值、权限点、可否后台修改',
  (key) => {
    const descriptor = killSwitchDescriptor(key);
    expect(descriptor).not.toBeNull();
    const expected = staticFields(key);
    expect({
      key: descriptor!.key,
      default: descriptor!.default,
      value_type: descriptor!.valueType,
      options: descriptor!.options === null ? null : [...descriptor!.options],
      permissions: [...descriptor!.permissions].sort(),
      admin_editable: descriptor!.adminEditable,
    }).toEqual(expected);
  },
);

it.each(NOT_SWITCHES.map(([key, why]) => [key, why] as const))(
  '[AC-F1-10d#28] §9.2 #2 未登记的键 %j（%s）没有登记信息，任何值都以 key 拒绝',
  (key) => {
    expect(killSwitchDescriptor(key)).toBeNull();
    for (const value of [true, false, 'maintenance', null, {}]) {
      expect(killSwitchChangeRefusal(key, value)).toBe('key');
    }
  },
);

it.each(['agent.whitelist_only', 'agent.model_route'])(
  '[AC-F1-10d#29] §9.2 #2 后台暂不可改的 %s 任何值（含类型正确的值）都以 key 拒绝',
  (key) => {
    for (const value of [true, false, { primary: 'x' }, [], null, 'on']) {
      expect(killSwitchChangeRefusal(key, value)).toBe('key');
    }
  },
);

it.each(EXPECTED.filter((row) => row.adminEditable).map((row) => [row.sample, row] as const))(
  '[AC-F1-10d#30] §9.2 #2 值按登记类型校验：%s 接受类型正确的值，其余以 value 拒绝',
  (key, row) => {
    if (row.valueType.kind === 'enum') {
      for (const value of row.valueType.values)
        expect(killSwitchChangeRefusal(key, value)).toBe(null);
      for (const value of ENUM_INVALID) expect(killSwitchChangeRefusal(key, value)).toBe('value');
      return;
    }
    expect(row.valueType.kind).toBe('boolean');
    expect(killSwitchChangeRefusal(key, false)).toBe(null);
    expect(killSwitchChangeRefusal(key, true)).toBe(
      key === 'withdraw.auto_payout.enabled' ? 'value' : null,
    );
    for (const value of BOOLEAN_INVALID) expect(killSwitchChangeRefusal(key, value)).toBe('value');
  },
);

it('[AC-F1-10d#31] 裁定 12 / BR-WDR-30：withdraw.auto_payout.enabled 后台只能改为 false，改为 true 以 value 拒绝', () => {
  expect(killSwitchChangeRefusal('withdraw.auto_payout.enabled', true)).toBe('value');
  expect(killSwitchChangeRefusal('withdraw.auto_payout.enabled', false)).toBe(null);
  // Turning it on is refused however it is spelled; other switches are not restricted this way.
  expect(killSwitchChangeRefusal('withdraw.auto_payout.enabled', 'true')).toBe('value');
  expect(killSwitchChangeRefusal('withdraw.enabled', true)).toBe(null);
  expect(killSwitchChangeRefusal('payout.enabled', true)).toBe(null);
  expect(killSwitchDescriptor('withdraw.auto_payout.enabled')).toMatchObject({
    adminEditable: true,
    default: false,
  });
});
