import { expect, it } from 'vitest';
import {
  isAwaitingPaymentDrop,
  isOrderSourceMismatch,
} from '../../../../apps/api/src/modules/orders/domain/jd-status.ts';
import { MAPPED, UNMAPPED } from './kit.ts';

const ALL_CODES = [...MAPPED.map(([code]) => code), ...UNMAPPED];
const NOT_EXACT = ['', '014', '14 ', ' 14', '14.0', '015', '15 ', ' 15', '15.0', null];
const NOT_MISMATCH = [...ALL_CODES.filter((code) => code !== '14' && code !== '40'), ...NOT_EXACT];
const NOT_AWAITING = [...ALL_CODES.filter((code) => code !== '15'), ...NOT_EXACT];

it.each(['14', '40'])('[AC-B1-04zg#6] D10-529：京东 %s 算推广位或 siteId 配置错误', (rawCode) => {
  expect(isOrderSourceMismatch('jd', rawCode)).toBe(true);
});

it.each(NOT_MISMATCH)('[AC-B1-04zg#7] D10-529：京东 %s 不算配置错误', (rawCode) => {
  expect(isOrderSourceMismatch('jd', rawCode)).toBe(false);
});

it.each([
  ['pdd', '14'],
  ['pdd', '40'],
  ['taobao', '14'],
  ['taobao', '40'],
] as const)('[AC-B1-04zg#8] D10-529：%s 的 %s 不算配置错误', (platform, rawCode) => {
  expect(isOrderSourceMismatch(platform, rawCode)).toBe(false);
});

it('[AC-B1-04zg#9] BR-ATTR-25：京东 15 待付款没有付款时间是常态', () => {
  expect(isAwaitingPaymentDrop('jd', '15')).toBe(true);
});

it.each(NOT_AWAITING)('[AC-B1-04zg#10] BR-ATTR-25：京东 %s 不算待付款', (rawCode) => {
  expect(isAwaitingPaymentDrop('jd', rawCode)).toBe(false);
});

it.each(['pdd', 'taobao'] as const)(
  '[AC-B1-04zg#11] BR-ATTR-25：%s 的 15 不算京东待付款',
  (platform) => {
    expect(isAwaitingPaymentDrop(platform, '15')).toBe(false);
  },
);
