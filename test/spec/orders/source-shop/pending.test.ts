import { expect, it } from 'vitest';
import {
  shouldDeferOrderSource,
  type DeferOrderSourceInput,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { capture, NONE } from '../source-backfill/kit.ts';

// BR-ATTR-15 的终结条件是已有 source_match（包括 none）。08 没有来源重试次数 / 放弃期限；
// B1-08p 编排补充口径 4～6 默认仅在店铺首次补到时再回填，不计数、不按时间 / 状态放弃。
it.each(['share', 'agent', 'fallback'])(
  '[AC-B1-08p#1] %s 场景已知、店铺显式 null 且无命中时保留待补',
  async (pidScene) => {
    const input: DeferOrderSourceInput = Object.freeze({
      source: Object.freeze({ ...NONE, source_match: 'none' as const }),
      incomingShopId: null,
      currentShopId: null,
      pidScene,
    });
    const result = await capture(() => shouldDeferOrderSource(input));
    expect(result).toEqual({ ok: true, value: true });
  },
);

it.each([
  { incomingShopId: undefined, currentShopId: null, pidScene: 'share' },
  { incomingShopId: '123', currentShopId: null, pidScene: 'share' },
  { incomingShopId: null, currentShopId: '123', pidScene: 'share' },
  { incomingShopId: null, currentShopId: null, pidScene: null },
])('[AC-B1-08p#2] 无店铺能力、店铺已知或场景未知均不暂缓：%j', async (patch) => {
  const result = await capture(() =>
    shouldDeferOrderSource({
      source: { ...NONE, source_match: 'none' },
      ...patch,
    }),
  );
  expect(result).toEqual({ ok: true, value: false });
});

it.each(['exact', 'product', 'shop'] as const)(
  '[AC-B1-08p#3] %s 已命中不受缺店铺影响',
  async (source_match) => {
    const result = await capture(() =>
      shouldDeferOrderSource({
        source: { source_match, source_scene: 'agent', link_id: 'link-1', agent_session_id: 's-1' },
        incomingShopId: null,
        currentShopId: null,
        pidScene: 'share',
      }),
    );
    expect(result).toEqual({ ok: true, value: false });
  },
);
