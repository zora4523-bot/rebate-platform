// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { BridgeError, createH5TokenManager, type H5ApiResponse } from '@couli/bridge-sdk';
import { controlledBridge, settled, token } from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('[F1-01l] [AC-F1-01l#1] invalidate 的发送边界：等待取令牌的写请求改用新令牌，已发出的请求仍完成', async () => {
  vi.useFakeTimers();
  const native = controlledBridge();
  const manager = createH5TokenManager();
  const responseA = { code: 0, msg: '', data: 'response-A' };
  const sendA = vi
    .fn<(value: string) => Promise<H5ApiResponse<string>>>()
    .mockResolvedValue(responseA);
  const resultA = settled(manager.request('POST', sendA));
  await vi.advanceTimersByTimeAsync(0);
  expect(native.postMessage).toHaveBeenCalledTimes(1);
  expect(sendA).not.toHaveBeenCalled();

  manager.invalidate();
  native.reply(0, { code: 0, msg: '', data: token('old') });
  await vi.advanceTimersByTimeAsync(0);
  expect(sendA).not.toHaveBeenCalled();
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  native.reply(1, { code: 0, msg: '', data: token('new') });
  await expect(resultA).resolves.toEqual({ status: 'fulfilled', value: responseA });
  expect(sendA).toHaveBeenCalledExactlyOnceWith('new');

  // The same boundary with a cached token: once send has started, invalidate cannot retract it.
  const serverB = Promise.withResolvers<H5ApiResponse<string>>();
  const sendB = vi
    .fn<(value: string) => Promise<H5ApiResponse<string>>>()
    .mockReturnValue(serverB.promise);
  const resultB = settled(manager.request('POST', sendB));
  await vi.advanceTimersByTimeAsync(0);
  expect(sendB).toHaveBeenCalledExactlyOnceWith('new');
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  manager.invalidate();

  const responseC = { code: 0, msg: '', data: 'response-C' };
  const sendC = vi
    .fn<(value: string) => Promise<H5ApiResponse<string>>>()
    .mockResolvedValue(responseC);
  const resultC = settled(manager.request('POST', sendC));
  await vi.advanceTimersByTimeAsync(0);
  expect(sendC).not.toHaveBeenCalled();
  expect(native.postMessage).toHaveBeenCalledTimes(3);
  native.reply(2, { code: 0, msg: '', data: token('next-account') });
  await expect(resultC).resolves.toEqual({ status: 'fulfilled', value: responseC });
  expect(sendC).toHaveBeenCalledExactlyOnceWith('next-account');

  const responseB = { code: 0, msg: '', data: 'response-B' };
  serverB.resolve(responseB);
  await expect(resultB).resolves.toEqual({ status: 'fulfilled', value: responseB });
  expect(sendB).toHaveBeenCalledExactlyOnceWith('new');
  await expect(manager.getToken({ forWrite: true })).resolves.toEqual(token('next-account'));
  expect(native.postMessage.mock.calls.map(([request]) => request.method)).toEqual([
    'auth.getH5Token',
    'auth.getH5Token',
    'auth.getH5Token',
  ]);
});

it('[F1-01l] [AC-F1-01l#2] invalidate 后重新取令牌失败，等待中的写请求收到原生失败且从未 send', async () => {
  vi.useFakeTimers();
  const native = controlledBridge();
  const manager = createH5TokenManager();
  const send = vi
    .fn<(value: string) => Promise<H5ApiResponse>>()
    .mockResolvedValue({ code: 0, msg: '' });
  const result = settled(manager.request('POST', send));
  await vi.advanceTimersByTimeAsync(0);
  expect(native.postMessage).toHaveBeenCalledTimes(1);
  manager.invalidate();
  native.reply(0, { code: 0, msg: '', data: token('old') });
  await vi.advanceTimersByTimeAsync(0);
  expect(send).not.toHaveBeenCalled();
  expect(native.postMessage).toHaveBeenCalledTimes(2);

  native.reply(1, { code: 90401, msg: 'logged out' });
  await expect(result).resolves.toEqual({
    status: 'rejected',
    reason: expect.any(BridgeError),
  });
  await expect(result).resolves.toMatchObject({ reason: { code: 90401, msg: 'logged out' } });
  expect(send).not.toHaveBeenCalled();
  expect(native.postMessage.mock.calls.map(([request]) => request.method)).toEqual([
    'auth.getH5Token',
    'auth.getH5Token',
  ]);
});
