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

it('routes carry their entry list and release builds drop debug_only routes (BR-ID-10 细则)', () => {
  expect(bridge.routes.Withdraw.entry).toEqual(['in_app', 'push']);
  expect(bridge.routes.ExternalPage.entry).toEqual(['in_app', 'push', 'deeplink']);
  expect(bridge.routes.HomePreview.entry).toEqual(['in_app', 'deeplink']);
  expect(bridge.releaseRouteNames).not.toContain('HomePreview');
  expect(bridge.releaseRouteNames).toContain('AuthManage');
});

it('every external target is trade_only; SDK queries and inbound start empty (04 §9)', () => {
  for (const app of Object.values(bridge.apps)) expect(app.trade_only).toBe(true);
  expect(bridge.sdkQueries).toEqual([]);
  expect(bridge.inbound).toEqual([]);
});

it('clipboard.write stays L0 but needs a user gesture; L2 methods imply one (04 §9, 03 §5.3)', () => {
  expect(bridge.bridgeMethods['clipboard.write'].level).toBe('L0');
  expect(bridge.bridgeMethods['clipboard.write'].gesture_required).toBe(true);
  for (const meta of Object.values(bridge.bridgeMethods)) {
    if (meta.level === 'L2') expect(meta.gesture_required).toBe(true);
  }
  expect(bridge.bridgeMethods['clipboard.setAutoDetect'].gesture_required).toBe(false);
});

it('the methods with their own 90403 whitelist rejection are exactly those of 03 §5.3', () => {
  const own = Object.entries(bridge.bridgeMethods)
    .filter(([, meta]) => meta.whitelist_90403)
    .map(([name]) => name)
    .sort();
  expect(own).toEqual(['ext.openApp', 'ext.openBrowser', 'net.signedRequest', 'share.open']);
  expect(bridge.bridgeErrorCodes).toContain(90403);
});

it('share.open registers the three share page path patterns once (04 §9; values not fixed yet)', () => {
  expect(Object.keys(bridge.sharePagePaths).sort()).toEqual([
    'download_guide',
    'invite_landing',
    'product_share',
  ]);
  for (const entry of Object.values(bridge.sharePagePaths)) {
    expect(entry.page.length).toBeGreaterThan(0);
    expect(entry.path_pattern).toBeNull();
  }
});

it('auth.getH5Token returns its scope; perm.request offers no camera in MVP (04 §9)', () => {
  expect(bridge.bridgeMethods['auth.getH5Token'].level).toBe('L1');
  expectTypeOf<bridge.BridgeMethods['auth.getH5Token']['result']['scope']>().toEqualTypeOf<
    'standard' | 'read_only'
  >();
  expectTypeOf<bridge.BridgeMethods['perm.request']['params']['type']>().toEqualTypeOf<
    'push' | 'photos'
  >();
});
