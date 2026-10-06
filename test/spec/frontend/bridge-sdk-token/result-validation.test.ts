// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { BridgeError, createH5TokenManager, type H5ApiResponse } from '@couli/bridge-sdk';
import { installBridge, token } from './kit.ts';

afterEach(() => vi.unstubAllGlobals());

// Source: contracts/bridge.schema.json methods.auth.getH5Token.result.
// Native data is unknown at runtime, regardless of the generated result's TypeScript type.
const malformed = [
  { name: '缺 token', data: { scope: 'standard', expire_at: '2099-01-01T00:00:00Z' } },
  { name: '空 token', data: { ...token('bad'), token: '' } },
  { name: '非字符串 token', data: { ...token('bad'), token: 123 } },
  { name: '缺 scope', data: { token: 'bad', expire_at: '2099-01-01T00:00:00Z' } },
  { name: '未知 scope', data: { ...token('bad'), scope: 'admin' } },
  { name: '缺 expire_at', data: { token: 'bad', scope: 'standard' } },
  { name: '非字符串 expire_at', data: { ...token('bad'), expire_at: 123 } },
  { name: '不是 date-time 的 expire_at', data: { ...token('bad'), expire_at: 'not-a-date' } },
];

it.each(malformed)(
  '[F1-01l] [AC-F1-01l#3] getToken 拒绝 $name，以 90500 结束且下一请求重新取令牌',
  async ({ data }) => {
    let acquisitions = 0;
    const fresh = token('valid-after-invalid');
    const native = installBridge((request) => ({
      id: request.id,
      code: 0,
      msg: '',
      data: acquisitions++ === 0 ? data : fresh,
    }));
    const manager = createH5TokenManager();
    const invalid = manager.getToken({ forWrite: false });
    await expect(invalid).rejects.toBeInstanceOf(BridgeError);
    await expect(invalid).rejects.toMatchObject({ code: 90500 });
    expect(native.postMessage).toHaveBeenCalledTimes(1);

    const response = { code: 0, msg: '', data: 'ok' };
    const send = vi
      .fn<(value: string) => Promise<H5ApiResponse<string>>>()
      .mockResolvedValue(response);
    await expect(manager.request('POST', send)).resolves.toEqual(response);
    expect(send).toHaveBeenCalledExactlyOnceWith(fresh.token);
    await expect(manager.getToken({ forWrite: false })).resolves.toEqual(fresh);
    expect(native.postMessage.mock.calls.map(([request]) => request.method)).toEqual([
      'auth.getH5Token',
      'auth.getH5Token',
    ]);
  },
);

it.each(malformed)(
  '[F1-01l] [AC-F1-01l#4] request 拒绝 $name，不 send、不缓存，下一请求重新取令牌',
  async ({ data }) => {
    let acquisitions = 0;
    const fresh = token('valid-after-invalid');
    const native = installBridge((request) => ({
      id: request.id,
      code: 0,
      msg: '',
      data: acquisitions++ === 0 ? data : fresh,
    }));
    const manager = createH5TokenManager();
    const response = { code: 0, msg: '', data: 'ok' };
    const send = vi
      .fn<(value: string) => Promise<H5ApiResponse<string>>>()
      .mockResolvedValue(response);
    const invalid = manager.request('POST', send);
    await expect(invalid).rejects.toBeInstanceOf(BridgeError);
    await expect(invalid).rejects.toMatchObject({ code: 90500 });
    expect(send).not.toHaveBeenCalled();
    expect(native.postMessage).toHaveBeenCalledTimes(1);

    await expect(manager.request('POST', send)).resolves.toEqual(response);
    expect(send).toHaveBeenCalledExactlyOnceWith(fresh.token);
    await expect(manager.getToken({ forWrite: true })).resolves.toEqual(fresh);
    expect(native.postMessage.mock.calls.map(([request]) => request.method)).toEqual([
      'auth.getH5Token',
      'auth.getH5Token',
    ]);
  },
);
