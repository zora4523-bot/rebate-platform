import { expect, expectTypeOf, it } from 'vitest';
import {
  CatalogConfigReader,
  LinkRegistrar,
  RebateQuoter,
  SourceLinkReader,
  ViewerContext,
  createGuestViewerContext,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import type { ContentReader } from '../../../../apps/api/src/modules/content/index.ts';

it('[AC-B1-05c#28] 未接身份端口时始终是游客，保留服务端应用与设备上下文', async () => {
  const scope = { appId: 'guest-a', deviceId: 'device-a', userId: 'untrusted-user' };
  const first = createGuestViewerContext(scope);
  const second = createGuestViewerContext({ appId: 'guest-b', deviceId: null });
  expect(await first.current()).toEqual({ appId: 'guest-a', userId: null, deviceId: 'device-a' });
  expect(await second.current()).toEqual({ appId: 'guest-b', userId: null, deviceId: null });
  expect(await first.current()).toEqual({ appId: 'guest-a', userId: null, deviceId: 'device-a' });
});

it('[AC-B1-05c#29] 五个端口具有不同注入令牌，配置读取可直接接 content 公共端口', async () => {
  const viewer = createGuestViewerContext({ appId: 'ports', deviceId: null });
  expect(await viewer.current()).toMatchObject({ userId: null });
  const ports = [LinkRegistrar, SourceLinkReader, RebateQuoter, ViewerContext, CatalogConfigReader];
  expect(new Set(ports).size).toBe(5);
  for (const port of ports) expect(typeof port).toBe('function');
  // Compile-time compatibility only: no fake content implementation or production wiring.
  expectTypeOf<ContentReader>().toExtend<CatalogConfigReader>();
});
