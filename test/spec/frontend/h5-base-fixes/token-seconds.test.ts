// @vitest-environment jsdom
import { BridgeError, createH5TokenManager, type H5ApiResponse } from '@couli/bridge-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { installBridge, token } from '../bridge-sdk-token/kit.ts';

afterEach(() => vi.unstubAllGlobals());

const cases = [
  { invalid: '2099-01-01T23:59:60Z', valid: '2099-01-01T23:59:59Z' },
  { invalid: '2099-01-01T12:00:60+08:00', valid: '2099-01-01T12:00:00+08:00' },
];

it.each(cases)(
  '[AC-F1-01o-TOKEN#1] getToken 拒绝秒 60：$invalid，90500 后不缓存并重新取令牌',
  async ({ invalid, valid }) => {
    let acquisitions = 0;
    const fresh = { ...token('fresh-after-invalid-seconds'), expire_at: valid };
    const native = installBridge((request) => ({
      id: request.id,
      code: 0,
      msg: '',
      data: acquisitions++ === 0 ? { ...token('bad-seconds'), expire_at: invalid } : fresh,
    }));
    const manager = createH5TokenManager();
    const result = manager.getToken({ forWrite: false });
    await expect(result).rejects.toBeInstanceOf(BridgeError);
    await expect(result).rejects.toMatchObject({ code: 90500 });
    expect(native.postMessage).toHaveBeenCalledTimes(1);

    await expect(manager.getToken({ forWrite: false })).resolves.toEqual(fresh);
    await expect(manager.getToken({ forWrite: true })).resolves.toEqual(fresh);
    expect(native.postMessage.mock.calls.map(([request]) => request.method)).toEqual([
      'auth.getH5Token',
      'auth.getH5Token',
    ]);
  },
);

it.each(cases)(
  '[AC-F1-01o-TOKEN#2] request 拒绝秒 60：$invalid，不 send，下一请求使用新令牌',
  async ({ invalid, valid }) => {
    let acquisitions = 0;
    const fresh = { ...token('fresh-for-request'), expire_at: valid };
    const native = installBridge((request) => ({
      id: request.id,
      code: 0,
      msg: '',
      data: acquisitions++ === 0 ? { ...token('bad-seconds'), expire_at: invalid } : fresh,
    }));
    const manager = createH5TokenManager();
    const response = { code: 0, msg: '', data: 'ok' };
    const send = vi
      .fn<(value: string) => Promise<H5ApiResponse<string>>>()
      .mockResolvedValue(response);
    const result = manager.request('POST', send);
    await expect(result).rejects.toBeInstanceOf(BridgeError);
    await expect(result).rejects.toMatchObject({ code: 90500 });
    expect(send).not.toHaveBeenCalled();
    expect(native.postMessage).toHaveBeenCalledTimes(1);

    await expect(manager.request('POST', send)).resolves.toEqual(response);
    expect(send).toHaveBeenCalledExactlyOnceWith(fresh.token);
    await expect(manager.getToken({ forWrite: false })).resolves.toEqual(fresh);
    expect(native.postMessage.mock.calls.map(([request]) => request.method)).toEqual([
      'auth.getH5Token',
      'auth.getH5Token',
    ]);
  },
);
