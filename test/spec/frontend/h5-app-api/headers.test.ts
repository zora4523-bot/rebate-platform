// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createAppApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { ENV, NATIVE_ENV, nativeBridge, envelope, transport } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('[AC-F1-01q-HEADERS#1] 请求头取构建品牌和桥版本，平台固定 h5，每次生成合法且不同的 trace', async () => {
  const native = nativeBridge();
  const wire = transport({ body: envelope({ id: 'me' }) }, { body: envelope({ id: 'me' }) });
  const client = createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch });
  expect(client).not.toBeNull();
  await client!.request('GET', '/v1/me', {});
  await client!.request('GET', '/v1/me', {});
  expect(native.bridge.isInApp).toHaveBeenCalled();
  expect(native.bridge.has).toHaveBeenCalledWith('app.getEnv');
  expect(native.bridge.call).toHaveBeenCalled();
  expect(vi.mocked(native.bridge.has).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(native.bridge.call).mock.invocationCallOrder[0]!,
  );
  expect(native.postMessage.mock.calls.map(([request]) => request.method)).toContain('app.getEnv');
  expect(wire.requests).toHaveLength(2);
  for (const request of wire.requests) {
    expect(request.url).toBe(`${ENV.apiBaseUrl}/v1/me`);
    expect(request.headers.get('X-App-Id')).toBe(ENV.appId);
    expect(request.headers.get('X-Platform')).toBe('h5');
    expect(request.headers.get('X-App-Version')).toBe(NATIVE_ENV.app_version);
    expect(request.headers.get('X-Build')).toBe(NATIVE_ENV.build);
    expect(request.headers.has('X-Channel')).toBe(false);
    expect(request.headers.get('X-Trace-Id')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    for (const header of ['X-Device-Id', 'X-Sign', 'X-Timestamp', 'X-Nonce']) {
      expect(request.headers.has(header), header).toBe(false);
    }
  }
  expect(wire.requests[0]!.headers.get('X-Trace-Id')).not.toBe(
    wire.requests[1]!.headers.get('X-Trace-Id'),
  );
});

it('[AC-F1-01q-HEADERS#2] 不支持 app.getEnv 时禁用客户端，不伪造必填版本或调用未声明桥方法', () => {
  const native = nativeBridge(['auth.getH5Token']);
  const wire = transport();
  expect(createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch })).toBeNull();
  expect(native.bridge.has).toHaveBeenCalledWith('app.getEnv');
  expect(native.bridge.call).not.toHaveBeenCalled();
  expect(native.postMessage).not.toHaveBeenCalled();
  expect(wire.fetch).not.toHaveBeenCalled();
});
