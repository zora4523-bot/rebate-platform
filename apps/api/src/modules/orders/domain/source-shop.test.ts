// B1-08p 源码旁单元测试：来源回填店铺维度的纯判定（BR-ATTR-15 ③；编排补充口径 2、4、5）。
import { expect, it } from 'vitest';
import type { OrderSourceMatch } from './source-backfill.ts';
import {
  incomingShopId,
  shopIdToWrite,
  shouldDeferOrderSource,
  shouldRetryOrderSource,
} from './source-shop.ts';

const NONE: OrderSourceMatch = {
  source_match: 'none',
  link_id: null,
  source_scene: null,
  agent_session_id: null,
};

it('[AC-B1-08p#U2] 报文店铺三态：键缺失为 undefined，null 与空串为 null，其余原样', () => {
  expect(incomingShopId({})).toBeUndefined();
  expect(incomingShopId({ shop_id: null })).toBeNull();
  expect(incomingShopId({ shop_id: '' })).toBeNull();
  expect(incomingShopId({ shop_id: '73129' })).toBe('73129');
});

it('[AC-B1-08p#U3] 店铺只空 → 非空：库内已有值或报文为空 / 缺失都不写', () => {
  expect(shopIdToWrite(null, '73129')).toBe('73129');
  for (const incoming of [null, undefined, '']) expect(shopIdToWrite(null, incoming)).toBeNull();
  for (const incoming of ['73129', 'other', null, undefined]) {
    expect(shopIdToWrite('73129', incoming)).toBeNull();
  }
});

it('[AC-B1-08p#U4] 待补只在 none + 报文店铺显式为空 + 库内为空 + 场景已知时成立', () => {
  const base = { source: NONE, incomingShopId: null, currentShopId: null, pidScene: 'share' };
  expect(shouldDeferOrderSource(base)).toBe(true);
  expect(shouldDeferOrderSource({ ...base, incomingShopId: '' })).toBe(true);
  expect(shouldDeferOrderSource({ ...base, pidScene: 'fallback' })).toBe(true);
  expect(shouldDeferOrderSource({ ...base, incomingShopId: undefined })).toBe(false);
  expect(shouldDeferOrderSource({ ...base, incomingShopId: '73129' })).toBe(false);
  expect(shouldDeferOrderSource({ ...base, currentShopId: '73129' })).toBe(false);
  expect(shouldDeferOrderSource({ ...base, pidScene: null })).toBe(false);
  for (const source_match of ['exact', 'product', 'shop'] as const) {
    expect(shouldDeferOrderSource({ ...base, source: { ...NONE, source_match } })).toBe(false);
  }
});

it('[AC-B1-08p#U5] 重跑只在已归属、来源未终结、库内无店铺而本次带来店铺时成立', () => {
  const base = {
    userId: 'user-U',
    sourceMatch: null,
    currentShopId: null,
    incomingShopId: '73129',
  };
  expect(shouldRetryOrderSource(base)).toBe(true);
  expect(shouldRetryOrderSource({ ...base, userId: null })).toBe(false);
  for (const sourceMatch of ['none', 'exact', 'product', 'shop']) {
    expect(shouldRetryOrderSource({ ...base, sourceMatch })).toBe(false);
  }
  expect(shouldRetryOrderSource({ ...base, currentShopId: '73129' })).toBe(false);
  for (const incomingShopId of [null, undefined, '']) {
    expect(shouldRetryOrderSource({ ...base, incomingShopId })).toBe(false);
  }
});
