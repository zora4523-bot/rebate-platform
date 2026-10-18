import { vi, expect } from 'vitest';
import * as sdk from '@couli/bridge-sdk';
import type { BridgeMethods } from '@couli/bridge-sdk';
import { installBridge } from '../bridge-sdk/kit.ts';
import type { AppApiBridge } from '../../../../apps/h5/src/shared/api/app-api.ts';
export { envelope, transport, requiredText, ROOT } from '../h5-shell/kit.ts';

export const ENV = { apiBaseUrl: 'https://api.fixture.invalid', appId: 'fixture_brand' };
export const NATIVE_ENV: BridgeMethods['app.getEnv']['result'] = {
  platform: 'android',
  app_version: '2.4.6',
  build: '2468',
  channel: 'official',
  os_version: '15',
  bridge_version: 1,
  safe_area: { top: 0, right: 0, bottom: 0, left: 0 },
};

export function nativeBridge(methods = ['app.getEnv', 'auth.getH5Token']) {
  let tokenCalls = 0;
  const native = installBridge(methods, (request) => {
    expect(methods).toContain(request.method);
    if (request.method === 'app.getEnv') {
      return { id: request.id, code: 0, msg: '', data: NATIVE_ENV };
    }
    if (request.method === 'net.signedRequest') {
      return {
        id: request.id,
        code: 0,
        msg: '',
        data: { status: 200, body: { code: 0, msg: '', data: {} } },
      };
    }
    expect(request.method).toBe('auth.getH5Token');
    tokenCalls += 1;
    return {
      id: request.id,
      code: 0,
      msg: '',
      data: {
        token: `fixture-memory-token-${tokenCalls}`,
        scope: 'standard',
        expire_at: '2099-01-01T00:00:00Z',
      },
    };
  });
  const manager = sdk.createH5TokenManager();
  const bridge: AppApiBridge = {
    isInApp: vi.fn(sdk.isInApp),
    // Vitest widens the generic capability; the wrapped SDK function preserves its M relation.
    has: vi.fn(sdk.has) as typeof sdk.has,
    call: vi.fn(sdk.call),
    createH5TokenManager: vi.fn(() => manager),
  };
  return { ...native, bridge, manager, tokenCalls: () => tokenCalls };
}

export function buildEnv() {
  vi.stubEnv('VITE_API_BASE_URL', ENV.apiBaseUrl);
  vi.stubEnv('VITE_APP_ID', ENV.appId);
  vi.stubEnv('VITE_MEDIA_ORIGINS', '');
}
