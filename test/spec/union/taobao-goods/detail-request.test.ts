import { expect, it } from 'vitest';
import type { ItemRef } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  businessFields,
  ctx,
  DETAIL,
  detailSetup,
  endpoint,
  formOf,
  ITEM_ID,
  ref,
  sent,
  unionFailure,
} from './kit.ts';

const twoIds = `${ITEM_ID},${ITEM_ID}9`;

it('[AC-B1-04l#1] getItem 只调一次 item.info.upgrade.get：item_id 原样、biz_scene_id=1，发往配置的网关', async () => {
  const { adapter, transport, credentials } = detailSetup();
  await adapter.getItem(ref, ctx);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(credentials).toHaveBeenCalledTimes(1);
  const request = sent(transport);
  expect(request).toMatchObject({ platform: 'taobao', method: 'POST', url: endpoint.baseUrl });
  expect(formOf(request)['method']).toBe(DETAIL);
  expect(businessFields(request)).toMatchObject({ item_id: ITEM_ID, biz_scene_id: '1' });
});

it('[AC-B1-04l#2] 详情请求带归档上下文 {appId, kind: query}，并挂上调用方的 AbortSignal', async () => {
  const { adapter, transport } = detailSetup();
  const controller = new AbortController();
  await adapter.getItem(ref, { ...ctx, signal: controller.signal });
  const request = sent(transport);
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'query' });
  expect(request.signal).toBe(controller.signal);
});

it.each<[string, ItemRef]>([
  ['没有 item_id', { platform: 'taobao' }],
  ['item_id 为 null', { platform: 'taobao', item_id: null }],
  ['item_id 为空串', { platform: 'taobao', item_id: '' }],
  ['item_id 为空白', { platform: 'taobao', item_id: '   ' }],
  ['item_id 含逗号（一次只取一个）', { platform: 'taobao', item_id: twoIds }],
])('[AC-B1-04l#3] %s → invalid_dto，不取凭据、不发请求', async (_case, bad) => {
  const { adapter, transport, credentials } = detailSetup();
  await unionFailure(() => adapter.getItem(bad, ctx), 'invalid_dto');
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
