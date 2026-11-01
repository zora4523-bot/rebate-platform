import { expect, it } from 'vitest';
import { isAwaitingPaymentDrop, isOrderSourceMismatch } from './jd-status.ts';

it('[AC-B1-04zg#6] 京东 14、40 算来源不符', () => {
  expect(isOrderSourceMismatch('jd', '14')).toBe(true);
  expect(isOrderSourceMismatch('jd', '40')).toBe(true);
});

it('[AC-B1-04zg#7] 京东别的码、空值、未归一的写法不算来源不符', () => {
  for (const rawStatus of ['15', '16', '014', '14 ', '', null]) {
    expect(isOrderSourceMismatch('jd', rawStatus)).toBe(false);
  }
});

it('[AC-B1-04zg#8] 其他平台的 14、40 不算来源不符', () => {
  expect(isOrderSourceMismatch('pdd', '14')).toBe(false);
  expect(isOrderSourceMismatch('taobao', '40')).toBe(false);
});

it('[AC-B1-04zg#9] 京东 15 算待付款', () => {
  expect(isAwaitingPaymentDrop('jd', '15')).toBe(true);
});

it('[AC-B1-04zg#10] 京东别的码、空值、未归一的写法不算待付款', () => {
  for (const rawStatus of ['14', '16', '015', '15 ', '', null]) {
    expect(isAwaitingPaymentDrop('jd', rawStatus)).toBe(false);
  }
});

it('[AC-B1-04zg#11] 其他平台的 15 不算待付款', () => {
  expect(isAwaitingPaymentDrop('pdd', '15')).toBe(false);
  expect(isAwaitingPaymentDrop('taobao', '15')).toBe(false);
});
