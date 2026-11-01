import { expect, it } from 'vitest';
import { expectRedacted, unionFailure } from '../jd-core/kit.ts';
import { num } from '../jd-orders/kit.ts';
import {
  clickUrl,
  ctx,
  failure,
  identity,
  innerCodes,
  itemId,
  JdIdentity,
  modePort,
  reply,
  req,
  subUnionId,
  success,
  upstreamText,
  warned,
  wire,
} from './kit.ts';

// 错误与告警不带 subUnionId、clickURL、itemId、message。
const markers = [subUnionId, clickUrl, itemId, upstreamText];

it.each(innerCodes)(
  '[AC-B1-04zd#33] 内层 %s 的错误不带请求内容与上游文案',
  async (code, expected) => {
    const h = wire(reply(failure(num(code))));
    const error = await unionFailure(() => h.adapter.convert(req, identity, ctx), expected);
    expectRedacted(error, markers);
  },
);

it.each(warned)('[AC-B1-04zd#34] 内层 %s 的错误与告警不带请求内容与上游文案', async (code) => {
  const h = wire(reply(failure(num(code))));
  const error = await unionFailure(
    () => h.adapter.convert(req, identity, ctx),
    'upstream_rejected',
  );
  expectRedacted(error, markers);
  expect(h.warn).toHaveBeenCalledTimes(1);
  expectRedacted(h.warn.mock.calls, markers);
});

it('[AC-B1-04zd#35] clickURL 不合格：错误不带链接原文', async () => {
  const bad = 'ftp://click-marker.invalid/synth01';
  const h = wire(reply(success({ clickURL: bad })));
  const error = await unionFailure(
    () => h.adapter.convert(req, identity, ctx),
    'upstream_unavailable',
  );
  expectRedacted(error, [bad, 'click-marker', subUnionId, itemId]);
});

it('[AC-B1-04zd#36] subUnionId 格式不合：错误不带原值', async () => {
  const bad = 'sub marker';
  const h = wire();
  const error = await unionFailure(
    () => h.adapter.convert(req, new JdIdentity({ subUnionId: bad }), ctx),
    'invalid_identity',
  );
  expectRedacted(error, [bad, itemId]);
});

it('[AC-B1-04zd#37] promotionSlot 不合格：错误不带原值', async () => {
  const bad = 'slot-marker';
  const h = wire();
  const error = await unionFailure(
    () => h.adapter.convert(req, new JdIdentity(undefined, { promotionSlot: bad }), ctx),
    'invalid_identity',
  );
  expectRedacted(error, [bad, subUnionId, itemId]);
});

it('[AC-B1-04zd#38] 商品键不合格：错误不带原值', async () => {
  const bad = 'leakA/leakB';
  const h = wire();
  const error = await unionFailure(
    () => h.adapter.convert({ ...req, item: { platform: 'jd', item_id: bad } }, identity, ctx),
    'invalid_dto',
  );
  expectRedacted(error, [bad, 'leakA', 'leakB', subUnionId]);
});

it('[AC-B1-04zd#39] sku 模式拒绝：错误不带商品键与 subUnionId', async () => {
  const h = wire(undefined, { productKeyMode: modePort('sku') });
  const error = await unionFailure(
    () => h.adapter.convert(req, identity, ctx),
    'link_unrecognized',
  );
  expectRedacted(error, [itemId, subUnionId]);
});
