import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  configItemSpecOf,
  configRegistry,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { readPayoutChannelConfig } from '../../../../apps/api/src/modules/payout/application/judgement.ts';
import type { PayoutConfigPort } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';

const DEFAULTS = {
  singleCapFen: 500000,
  dailyCapFen: 5000000,
  watermarkUsableBp: 9000,
  bizScene: '',
  querySchedule: { points_min: [1, 5, 30, 120], interval_min: 120, manual_after_min: 1440 },
  definiteFailCodes: [],
  payerSideCodes: [],
  queryStatusMap: { SUCCESS: 'success' },
};
const ITEMS = [
  ['payout.single_cap_fen', 'number'],
  ['payout.daily_cap_fen', 'number'],
  ['payout.watermark_usable_bp', 'number'],
  ['payout.biz_scene', 'string'],
  ['payout.query_schedule', 'object'],
  ['payout.definite_fail_codes', 'object'],
  ['payout.payer_side_codes', 'object'],
  ['payout.query_status_map', 'object'],
] as const;

// Opaque caller handles only: no Kysely instance, connection or SQL is created here.
const HANDLE = Object.freeze({ testHandle: 'caller' }) as unknown as Kysely<DB>;

it.each(ITEMS)(
  '[AC-B2-06b#8] %s is registered exactly once as config.business / %s',
  (key, valueType) => {
    expect(configItemSpecOf(key)).toMatchObject({ key, valueType, permission: 'config.business' });
    expect(configRegistry().filter((entry) => entry.key === key)).toHaveLength(1);
  },
);

it('[AC-B2-06b#9] missing rows produce all eight conservative defaults using the given app and handle', async () => {
  const configValue = vi.fn<PayoutConfigPort['configValue']>().mockResolvedValue(null);
  const warn = vi.fn();
  const result = await readPayoutChannelConfig('app_A', HANDLE, { configValue }, { warn });
  expect(result).toStrictEqual(DEFAULTS);
  expect(configValue.mock.calls.map(([, key]) => key).sort()).toStrictEqual(
    ITEMS.map(([key]) => key).sort(),
  );
  for (const [appId, , handle] of configValue.mock.calls) {
    expect(appId).toBe('app_A');
    expect(handle).toBe(HANDLE);
  }
});

it('[AC-B2-06b#10] valid explicit values are read without substituting a hardcoded error catalogue', async () => {
  const values: Record<string, unknown> = {
    'payout.single_cap_fen': 200000,
    'payout.daily_cap_fen': 2000000,
    'payout.watermark_usable_bp': 8000,
    'payout.biz_scene': 'TEST_SCENE',
    'payout.query_schedule': { points_min: [2, 10], interval_min: 60, manual_after_min: 720 },
    'payout.definite_fail_codes': ['TEST_FAIL'],
    'payout.payer_side_codes': ['TEST_PAYER'],
    'payout.query_status_map': { SUCCESS: 'success', TEST_FAIL: 'fail', TEST_PENDING: 'unknown' },
  };
  const configValue = vi.fn<PayoutConfigPort['configValue']>(async (_app, key) => ({
    value: values[key],
    version: 7,
  }));
  const warn = vi.fn();
  expect(await readPayoutChannelConfig('app_A', HANDLE, { configValue }, { warn })).toStrictEqual({
    singleCapFen: 200000,
    dailyCapFen: 2000000,
    watermarkUsableBp: 8000,
    bizScene: 'TEST_SCENE',
    querySchedule: values['payout.query_schedule'],
    definiteFailCodes: ['TEST_FAIL'],
    payerSideCodes: ['TEST_PAYER'],
    queryStatusMap: values['payout.query_status_map'],
  });
  expect(warn).not.toHaveBeenCalled();
});

it.each([
  ['payout.definite_fail_codes', 'TEST_FAIL'],
  ['payout.definite_fail_codes', ['TEST_FAIL', 123]],
  ['payout.payer_side_codes', { TEST_PAYER: true }],
  ['payout.payer_side_codes', [false]],
  ['payout.query_status_map', []],
  ['payout.query_status_map', { SUCCESS: 'paid' }],
  ['payout.query_status_map', { SUCCESS: 'success', TEST_BAD: 1 }],
  ['payout.single_cap_fen', '500000'],
  ['payout.daily_cap_fen', 1.5],
  ['payout.watermark_usable_bp', 10001],
  ['payout.biz_scene', { scene: 'TEST' }],
  ['payout.query_schedule', { points_min: '1,5,30', interval_min: 0 }],
  ['payout.definite_fail_codes', null],
])(
  '[AC-B2-06b#11] malformed %s falls back and warns instead of enabling an unverified decision',
  async (key, value) => {
    const configValue = vi.fn<PayoutConfigPort['configValue']>(async (_app, requested) =>
      requested === key ? { value, version: 1 } : null,
    );
    const warn = vi.fn();
    expect(await readPayoutChannelConfig('app_A', HANDLE, { configValue }, { warn })).toStrictEqual(
      DEFAULTS,
    );
    expect(warn).toHaveBeenCalled();
  },
);

it('[AC-B2-06b#12] configuration reads cannot reuse another app’s lists or an earlier version', async () => {
  let version = 1;
  const configValue = vi.fn<PayoutConfigPort['configValue']>(async (appId, key) =>
    key === 'payout.definite_fail_codes' ? { value: [`TEST_${appId}_${version}`], version } : null,
  );
  const read = (appId: string) =>
    readPayoutChannelConfig(appId, HANDLE, { configValue }, { warn: vi.fn() });
  expect((await read('A')).definiteFailCodes).toEqual(['TEST_A_1']);
  expect((await read('B')).definiteFailCodes).toEqual(['TEST_B_1']);
  version = 2;
  expect((await read('A')).definiteFailCodes).toEqual(['TEST_A_2']);
});
