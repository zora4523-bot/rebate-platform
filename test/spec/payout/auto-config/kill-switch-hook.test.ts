// B2-11d injection point in content/domain/kill-switch.ts (编排裁定 D10-224 ①; 规划/08 BR-WDR-30 细则
// 「开启前置检查」, BR-WDR-17): killSwitchChangeRefusalWith(key, value, checks) asks the injected
// payout precheck (checks.autoPayoutEnable) only when withdraw.auto_payout.enabled is turned on
// (JSON true); without it, or when it does not pass, turning it on stays refused as 'value' — the
// default keeps today's unconditional refusal. Turning it off is the safe direction and never
// asks. Every other change gets exactly killSwitchChangeRefusal's answer, without asking.
import { expect, it, vi } from 'vitest';
import {
  killSwitchChangeRefusal,
  killSwitchChangeRefusalWith,
} from '../../../../apps/api/src/modules/content/domain/kill-switch.ts';
import { switchRegistry } from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import { checkAutoPayoutEnable } from '../../../../apps/api/src/modules/payout/domain/auto-config.ts';
import { enablePassing } from './kit.ts';

const AUTO = 'withdraw.auto_payout.enabled';

function precheck(passed: boolean) {
  return vi.fn(() => ({ passed }));
}

it('[AC-B2-11d#19] 缺省（不注入前置检查）：打开自动到账总开关仍拒绝 value，与现在一致', () => {
  expect(killSwitchChangeRefusalWith(AUTO, true, {})).toBe('value');
  expect(killSwitchChangeRefusal(AUTO, true)).toBe('value');
});

it('[AC-B2-11d#20] 注入的前置检查不通过 → 拒绝 value，检查被问了一次', () => {
  const check = precheck(false);
  expect(killSwitchChangeRefusalWith(AUTO, true, { autoPayoutEnable: check })).toBe('value');
  expect(check).toHaveBeenCalledTimes(1);
});

it('[AC-B2-11d#21] 注入的前置检查通过 → 可以打开', () => {
  const check = precheck(true);
  expect(killSwitchChangeRefusalWith(AUTO, true, { autoPayoutEnable: check })).toBeNull();
  expect(check).toHaveBeenCalledTimes(1);
});

it('[AC-B2-11d#22] 关闭属安全方向：不问前置检查，检查不通过也可以关', () => {
  const failing = precheck(false);
  expect(killSwitchChangeRefusalWith(AUTO, false, { autoPayoutEnable: failing })).toBeNull();
  expect(killSwitchChangeRefusalWith(AUTO, false, {})).toBeNull();
  expect(failing).not.toHaveBeenCalled();
});

it.each([{ value: 'on' }, { value: 1 }, { value: null }, { value: 'true' }, { value: {} }])(
  '[AC-B2-11d#23] 值不是布尔（$value）：前置检查通过也拒绝 value',
  ({ value }) => {
    expect(killSwitchChangeRefusalWith(AUTO, value, { autoPayoutEnable: precheck(true) })).toBe(
      'value',
    );
  },
);

/** Every registered switch other than AUTO, placeholders filled with one valid segment. */
const OTHER_KEYS = switchRegistry()
  .map((spec) => spec.pattern.replace(/<[a-z_]+>/u, 'alipay'))
  .filter((key) => key !== AUTO);

it('[AC-B2-11d#24] 其余开关与未登记的键：结果与 killSwitchChangeRefusal 完全相同，且不问前置检查', () => {
  expect(OTHER_KEYS.length).toBeGreaterThan(10);
  const values: unknown[] = [true, false, 'on', 'maintenance', 'not_launched', null, 1, {}];
  for (const key of [...OTHER_KEYS, 'withdraw.auto_payout', 'withdraw.auto_payout.enabled.x']) {
    for (const value of values) {
      const passing = precheck(true);
      const failing = precheck(false);
      const expected = killSwitchChangeRefusal(key, value);
      expect(killSwitchChangeRefusalWith(key, value, { autoPayoutEnable: passing }), key).toBe(
        expected,
      );
      expect(killSwitchChangeRefusalWith(key, value, { autoPayoutEnable: failing }), key).toBe(
        expected,
      );
      expect(killSwitchChangeRefusalWith(key, value, {}), key).toBe(expected);
      expect(passing, key).not.toHaveBeenCalled();
      expect(failing, key).not.toHaveBeenCalled();
    }
  }
});

it('[AC-B2-11d#25] 接上 payout 的开启前置检查：未登记验证状态与天数时拒绝打开，全部登记且达标后可以打开', () => {
  const unregistered = new Map<string, unknown>();
  expect(
    killSwitchChangeRefusalWith(AUTO, true, {
      autoPayoutEnable: () => checkAutoPayoutEnable(unregistered),
    }),
  ).toBe('value');
  const registered = enablePassing();
  expect(
    killSwitchChangeRefusalWith(AUTO, true, {
      autoPayoutEnable: () => checkAutoPayoutEnable(registered),
    }),
  ).toBeNull();
});
