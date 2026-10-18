// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mediaOrigins, readAppApiEnv } from '../../../../apps/h5/src/shared/env.ts';
import { createAppApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { ENV, buildEnv, nativeBridge, envelope, transport } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('[AC-F1-01q-ENV#1] 统一入口读取构建环境，默认客户端使用该品牌和 API 基址', async () => {
  buildEnv();
  const native = nativeBridge();
  expect(readAppApiEnv()).toEqual(ENV);
  const wire = transport({ body: envelope({ id: 'me' }) });
  const client = createAppApi({ bridge: native.bridge, fetch: wire.fetch });
  expect(client).not.toBeNull();
  await client!.request('GET', '/v1/me', {});
  expect(wire.requests[0]!.url).toBe(`${ENV.apiBaseUrl}/v1/me`);
  expect(wire.requests[0]!.headers.get('X-App-Id')).toBe(ENV.appId);
});

it('[AC-F1-01q-ENV#2] 注入环境优先于构建默认值，允许另一环境的同一套客户端接线', async () => {
  buildEnv();
  const native = nativeBridge();
  const wire = transport({ body: envelope({ id: 'me' }) });
  const client = createAppApi({
    env: { apiBaseUrl: 'https://staging.fixture.invalid', appId: 'other_brand' },
    bridge: native.bridge,
    fetch: wire.fetch,
  });
  expect(client).not.toBeNull();
  await client!.request('GET', '/v1/me', {});
  expect(wire.requests[0]!.url).toBe('https://staging.fixture.invalid/v1/me');
  expect(wire.requests[0]!.headers.get('X-App-Id')).toBe('other_brand');
});

it.each([undefined, '', '   '])(
  '[AC-F1-01q-ENV#3] API 基址缺失或空白（%s）不构造客户端，不退回页面同源请求',
  (value) => {
    buildEnv();
    vi.stubEnv('VITE_API_BASE_URL', value);
    const native = nativeBridge();
    const wire = transport();
    expect(readAppApiEnv().apiBaseUrl).toBeNull();
    expect(createAppApi({ bridge: native.bridge, fetch: wire.fetch })).toBeNull();
    expect(native.postMessage).not.toHaveBeenCalled();
    expect(wire.fetch).not.toHaveBeenCalled();
  },
);

it('[AC-F1-01q-ENV#4] 缺少品牌编号时不猜测 app_id，也不构造客户端', () => {
  buildEnv();
  vi.stubEnv('VITE_APP_ID', undefined);
  const native = nativeBridge();
  const wire = transport();
  expect(readAppApiEnv().appId).toBeNull();
  expect(createAppApi({ bridge: native.bridge, fetch: wire.fetch })).toBeNull();
  expect(native.postMessage).not.toHaveBeenCalled();
  expect(wire.fetch).not.toHaveBeenCalled();
});

it('[AC-F1-01q-ENV#5] 媒体允许域从完整 origin 列表读取，逗号分隔并去除空白', () => {
  vi.stubEnv(
    'VITE_MEDIA_ORIGINS',
    'https://media.fixture.invalid, https://cdn.fixture.invalid:8443',
  );
  expect(mediaOrigins()).toEqual([
    'https://media.fixture.invalid',
    'https://cdn.fixture.invalid:8443',
  ]);
});

it.each([undefined, '', '  '])(
  '[AC-F1-01q-ENV#6] 媒体配置缺失或空白（%s）即不允许任何域',
  (value) => {
    vi.stubEnv('VITE_MEDIA_ORIGINS', value);
    expect(mediaOrigins()).toEqual([]);
  },
);

it.each(['*', '*.fixture.invalid', 'https://media.fixture.invalid/images', 'javascript:alert(1)'])(
  '[AC-F1-01q-ENV#7] 非完整 HTTP(S) origin（%s）不进入图片允许域',
  (value) => {
    vi.stubEnv('VITE_MEDIA_ORIGINS', value);
    expect(mediaOrigins()).toEqual([]);
  },
);
