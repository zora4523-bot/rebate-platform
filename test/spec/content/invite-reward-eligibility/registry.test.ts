import { expect, it } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  CLIENT_CONFIG_KEYS,
  buildClientConfig,
} from '../../../../apps/api/src/modules/content/domain/client-config.ts';
import {
  INVITE_REWARD_POSITIVE_KEYS,
  inviteRewardGuardedKey,
  inviteRewardOpenRefused,
} from '../../../../apps/api/src/modules/content/domain/invite-reward.ts';
import { switchSpecOf } from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import { AMOUNT, DAILY, DEFAULTS, ENABLED, KEY, SPEC, TOTAL, WINDOW } from './oracle.ts';

it('[AC-F1-02zx#1] 资格天数是唯一的可改业务配置，整数范围 1–3650，不是开关', () => {
  const spec = configItemSpecOf(KEY);
  expect(spec).toStrictEqual(SPEC);
  expect(configRegistry().filter((entry) => entry.key === KEY)).toStrictEqual([SPEC]);
  expect(switchSpecOf(KEY)).toBeNull();
  expect(Object.isFrozen(configRegistry())).toBe(true);
  expect(Object.isFrozen(spec)).toBe(true);
  expect(Object.isFrozen(spec!.range)).toBe(true);
});

it('[AC-F1-02zx#2] 六项邀请奖励配置连续位于注册表末尾，资格天数紧接 IP 窗口', () => {
  const registry = configRegistry();
  expect(
    registry
      .filter((entry) => entry.key.startsWith('growth.invite_reward.'))
      .map((entry) => entry.key),
  ).toStrictEqual(DEFAULTS.map((row) => row.key));
  expect(registry.slice(-6).map((entry) => entry.key)).toStrictEqual(
    DEFAULTS.map((row) => row.key),
  );
  expect(registry.at(-2)?.key).toBe(WINDOW);
  expect(registry.at(-1)?.key).toBe(KEY);
});

it.each([1, 2, 30, 3649, 3650])('[AC-F1-02zx#3] 资格天数接受整数 %s', (value) => {
  const spec = configItemSpecOf(KEY);
  expect(spec, '必须先登记；缺键不能当作校验结果').not.toBeNull();
  expect(configValueFits(spec!, value)).toBe(true);
});

it.each([
  { label: '零', value: 0 },
  { label: '负数', value: -1 },
  { label: '超过十年', value: 3651 },
  { label: 'int32 上限', value: 2147483647 },
  { label: '非整数', value: 30.5 },
  { label: 'NaN', value: NaN },
  { label: '正无穷', value: Infinity },
  { label: '负无穷', value: -Infinity },
  { label: '字符串', value: '30' },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: '布尔', value: true },
  { label: '数组', value: [] },
  { label: '对象', value: {} },
])('[AC-F1-02zx#4] 资格天数拒绝 $label', ({ value }) => {
  const spec = configItemSpecOf(KEY);
  expect(spec, '必须先登记；避免把 null 传入校验器造成 TypeError').not.toBeNull();
  expect(configValueFits(spec!, value)).toBe(false);
});

it('[AC-F1-02zx#5] 登记资格天数不扩大活动正数校验，也不增加客户端读取或下发', () => {
  expect(configItemSpecOf(KEY)).toStrictEqual(SPEC);
  expect(INVITE_REWARD_POSITIVE_KEYS).toStrictEqual([AMOUNT, DAILY, TOTAL]);
  expect(inviteRewardGuardedKey(KEY)).toBe(false);
  expect(
    inviteRewardOpenRefused(
      new Map([
        [AMOUNT, 100],
        [DAILY, 100],
        [TOTAL, 100],
      ]),
    ),
  ).toBe(false);
  expect(CLIENT_CONFIG_KEYS).not.toContain(KEY);
  for (const days of [undefined, 45]) {
    const values = new Map<string, unknown>([
      [ENABLED, true],
      [AMOUNT, 1000],
      ['h5_base_url', 'https://h5.example.test/'],
      ['h5_release.stable', 'stable'],
      ['kf', { url: 'https://kf.example.test/' }],
      ['legal.privacy.version', 1],
      ['legal.privacy.min_version', 1],
      ['legal.agreement.version', 1],
    ]);
    if (days !== undefined) values.set(KEY, days);
    const reports: string[] = [];
    const config = buildClientConfig({
      values,
      viewer: { appId: 'f1-02zx-client', userId: null },
      deviceId: null,
      linkPatterns: { version: '1', rules: [] },
      rankPlatforms: [],
      inviteRewardBudgetFen: 2000,
      report: {
        missing: (key) => {
          reports.push(key);
        },
        invalid: (key) => {
          reports.push(key);
        },
      },
    });
    expect(config).toBeDefined();
    expect(config!.invite).toStrictEqual({
      required: false,
      backfill_hours: 168,
      bind_phone_guide: true,
      before_buy_tip: true,
      reward_enabled: true,
      reward_amount_fen: 1000,
    });
    expect(reports).toStrictEqual([]);
  }
});
