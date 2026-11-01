// B1-06zd rule tests: the pure parts of D10-510 — which registered links get a prefetch job, the
// per-minute limit as read from configuration (default 60), and the three configuration keys.
import { expect, it } from 'vitest';
import { configItemSpecOf } from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { switchSpecOf } from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import {
  promoPrefetchEligible,
  promoPrefetchRatePerMin,
  type PromoPrefetchCandidate,
} from '../../../../apps/api/src/modules/linking/application/promo-prefetch.ts';

const SHARE_SWITCH = 'share.taobao_enabled';
const PREFETCH_SWITCH = 'convert.taobao_prefetch.enabled';
const PREFETCH_RATE = 'convert.taobao_prefetch.rate_per_min';

const ELIGIBLE: PromoPrefetchCandidate = {
  platform: 'taobao',
  entrySource: 'detail',
  userId: '0199a3b4-5c6d-7000-8000-0000000000a1',
  rebateBasis: 'normal',
  relationId: '912345678',
};

it.each(['normal', 'price_compare_risk'])(
  '[AC-B1-06zd#43] 登录用户的淘宝详情 link、有 relation_id、卡片返利口径 %s → 投',
  (rebateBasis) => {
    expect(promoPrefetchEligible({ ...ELIGIBLE, rebateBasis })).toBe(true);
  },
);

it.each([
  { label: '京东', patch: { platform: 'jd' } },
  { label: '拼多多', patch: { platform: 'pdd' } },
  { label: '搜索卡', patch: { entrySource: 'search' } },
  { label: '信息流卡', patch: { entrySource: 'feed' } },
  { label: '解析卡', patch: { entrySource: 'parse' } },
  { label: '榜单卡', patch: { entrySource: 'rank' } },
  { label: '商品池卡', patch: { entrySource: 'pool' } },
  { label: '分享', patch: { entrySource: 'share' } },
  { label: '来源读不到', patch: { entrySource: null } },
  { label: '未登录', patch: { userId: null } },
  { label: 'no_rebate', patch: { rebateBasis: 'no_rebate' } },
  { label: '没有 relation_id', patch: { relationId: null } },
  { label: 'relation_id 为空串', patch: { relationId: '' } },
])('[AC-B1-06zd#44] $label → 不投', ({ patch }) => {
  expect(promoPrefetchEligible({ ...ELIGIBLE, ...patch })).toBe(false);
});

it.each([
  { label: '未配置', value: undefined, expected: 60 },
  { label: 'null', value: null, expected: 60 },
  { label: '文本', value: '5', expected: 60 },
  { label: '小数', value: 1.5, expected: 60 },
  { label: '负数', value: -1, expected: 60 },
  { label: '配置值', value: 5, expected: 5 },
  { label: '大于默认值的配置值', value: 120, expected: 120 },
])('[AC-B1-06zd#45] rate_per_min $label → $expected', ({ value, expected }) => {
  expect(promoPrefetchRatePerMin(value)).toBe(expected);
});

it.each([SHARE_SWITCH, PREFETCH_SWITCH])(
  '[AC-B1-06zd#46] %s 登记为布尔配置项，不是紧急开关',
  (key) => {
    expect(configItemSpecOf(key)).toMatchObject({ key, valueType: 'boolean', adminEditable: true });
    expect(switchSpecOf(key)).toBeNull();
  },
);

it('[AC-B1-06zd#47] rate_per_min 登记为至少 1 的整数配置项', () => {
  const spec = configItemSpecOf(PREFETCH_RATE);
  expect(spec).toMatchObject({ key: PREFETCH_RATE, valueType: 'number', adminEditable: true });
  expect(spec?.range).toMatchObject({ integer: true, min: 1 });
  expect(switchSpecOf(PREFETCH_RATE)).toBeNull();
});
