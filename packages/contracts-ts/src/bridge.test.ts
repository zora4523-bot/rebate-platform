import { expect, expectTypeOf, it } from 'vitest';
import { bridge } from './index.ts';

it('net.signedRequest may sign only the whitelisted method + path (拍板第二批 TECH-30)', () => {
  expect(bridge.signedPaths).toEqual([{ method: 'POST', path: '/v1/orders/claims' }]);
  expect(bridge.bridgeMethods['net.signedRequest'].level).toBe('L2');
});

it('sensitive methods need a user gesture (L2) and sync methods have no timeout (03 §5.3)', () => {
  for (const name of ['trade.convertAndOpen', 'trade.authorize', 'clipboard.read']) {
    expect(bridge.bridgeMethods[name as bridge.BridgeMethodName].level).toBe('L2');
  }
  for (const meta of Object.values(bridge.bridgeMethods)) {
    if (meta.model === 'sync') expect(meta.timeout_ms).toBeNull();
  }
  expect(bridge.bridgeErrorCodes.every((c) => c >= 90001 && c <= 90500)).toBe(true);
});

it('routes carry a per-platform since and external links use ExternalPage (TECH-04, TECH-07)', () => {
  for (const route of Object.values(bridge.routes)) {
    expect(Object.keys(route.since).sort()).toEqual(['android', 'harmony', 'ios']);
  }
  const target: bridge.RouteTarget = {
    route: 'ExternalPage',
    params: { url: 'https://example.test/activity' },
  };
  expectTypeOf(target).toMatchTypeOf<bridge.RouteTarget>();
  // A route without required params may omit them; ProductDetail may not.
  expectTypeOf({ route: 'Home' as const }).toMatchTypeOf<bridge.RouteTarget>();
  expectTypeOf({ route: 'ProductDetail' as const }).not.toMatchTypeOf<bridge.RouteTarget>();
  expect(bridge.routes.ExternalPage.kind).toBe('native');
  expect(bridge.routes.FindOrder.h5_path).toBe('/find-order');
  expect(bridge.routes.HomePreview.debug_only).toBe(true);
  expectTypeOf<bridge.BridgeMethods['nav.open']['params']>().toEqualTypeOf<bridge.RouteTarget>();
});

it('clipboard.read is not offered on Harmony (04 §9: 90001 there)', () => {
  expect(bridge.bridgeMethods['clipboard.read'].since.harmony).toBeNull();
});

it('ext.openApp targets are exactly the apps.json keys', () => {
  expect(Object.keys(bridge.apps).sort()).toEqual(['jd', 'pdd', 'taobao']);
  expectTypeOf<
    bridge.BridgeMethods['ext.openApp']['params']['target']
  >().toEqualTypeOf<bridge.AppTarget>();
});
