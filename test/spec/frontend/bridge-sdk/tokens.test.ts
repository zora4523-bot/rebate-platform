// @vitest-environment jsdom
// BR-ID-32 / 03 §5.4. Native chooses scope; the SDK never upgrades it by itself.
import { afterEach, expect, it, vi } from 'vitest';
import { createH5TokenManager } from '@couli/bridge-sdk';
import { installBridge, outcome, token, tokenBridge } from './kit.ts';
import type { H5ApiResponse } from '@couli/bridge-sdk';

afterEach(() => vi.unstubAllGlobals());

it('[AC-F1-01b#16] standard 令牌在当前 manager 内缓存，invalidate 后重新向原生申请', async () => {
  const first = token('standard', 'first');
  const next = token('standard', 'next');
  const native = tokenBridge(first, next);
  const manager = createH5TokenManager();
  expect(native.postMessage).not.toHaveBeenCalled();
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(first);
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(first);
  await expect(manager.getToken({ forWrite: true })).resolves.toEqual(first);
  expect(native.postMessage).toHaveBeenCalledTimes(1);
  manager.invalidate();
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(next);
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  expect(native.postMessage.mock.calls.map(([request]) => request.method)).toEqual([
    'auth.getH5Token',
    'auth.getH5Token',
  ]);
});

it('[AC-F1-01b#17] read_only 可复用读请求，但每次 forWrite 都先重新取且保留原生 scope', async () => {
  const first = token('read_only', 'first');
  const stillReadOnly = token('read_only', 'still');
  const upgraded = token('standard', 'upgraded');
  const native = tokenBridge(first, stillReadOnly, upgraded);
  const manager = createH5TokenManager();
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(first);
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(first);
  expect(native.postMessage).toHaveBeenCalledTimes(1);
  await expect(manager.getToken({ forWrite: true })).resolves.toEqual(stillReadOnly);
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  await expect(manager.getToken({ forWrite: true })).resolves.toEqual(upgraded);
  await expect(manager.getToken({ forWrite: true })).resolves.toEqual(upgraded);
  expect(native.postMessage).toHaveBeenCalledTimes(3);
});

it('[AC-F1-01b#18] 无缓存时的首次写请求只申请一次，不因新令牌仍只读无限续取', async () => {
  const fresh = token('read_only', 'fresh');
  const native = tokenBridge(fresh);
  const manager = createH5TokenManager();
  await expect(manager.getToken({ forWrite: true })).resolves.toEqual(fresh);
  expect(native.postMessage).toHaveBeenCalledTimes(1);
});

it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])(
  '[AC-F1-01b#19] read_only 下 %s 也属于 GET 以外请求：send 前重取',
  async (method) => {
    const old = token('read_only', 'old');
    const fresh = token('read_only', 'fresh');
    const native = tokenBridge(old, fresh);
    const manager = createH5TokenManager();
    await manager.getToken({ forWrite: false });
    const send = vi.fn(async (value: string) => {
      expect(native.postMessage).toHaveBeenCalledTimes(2);
      expect(value).toBe(fresh.token);
      return { code: 0, msg: '', data: { ok: true } };
    });
    await expect(manager.request(method, send)).resolves.toEqual({
      code: 0,
      msg: '',
      data: { ok: true },
    });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('[AC-F1-01b#20] GET 复用只读令牌，不主动升级 scope', async () => {
  const readOnly = token('read_only', 'get');
  const native = tokenBridge(readOnly);
  const manager = createH5TokenManager();
  await manager.getToken({ forWrite: false });
  const send = vi.fn(async () => ({ code: 0, msg: '', data: 'ok' }));
  await expect(manager.request('GET', send)).resolves.toMatchObject({ code: 0 });
  expect(send).toHaveBeenCalledExactlyOnceWith(readOnly.token);
  expect(native.postMessage).toHaveBeenCalledTimes(1);
});

it('[AC-F1-01b#21] 10002 自动换取新令牌并重放原请求一次', async () => {
  const old = token('standard', 'expired');
  const fresh = token('standard', 'renewed');
  const native = tokenBridge(old, fresh);
  const manager = createH5TokenManager();
  const send = vi
    .fn<(value: string) => Promise<H5ApiResponse<string>>>()
    .mockResolvedValueOnce({ code: 10002, msg: 'expired' })
    .mockResolvedValueOnce({ code: 0, msg: '', data: 'ok' });
  await expect(manager.request('GET', send)).resolves.toEqual({ code: 0, msg: '', data: 'ok' });
  expect(send.mock.calls).toEqual([[old.token], [fresh.token]]);
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(fresh);
  expect(native.postMessage).toHaveBeenCalledTimes(2);
});

it('[AC-F1-01b#22] 重放仍是 10002 时返回失败，不无限续取重放', async () => {
  const native = tokenBridge(token('standard', 'old'), token('standard', 'new'));
  const manager = createH5TokenManager();
  const expired = { code: 10002, msg: 'expired again' };
  const send = vi.fn(async () => expired);
  await expect(manager.request('GET', send)).resolves.toEqual(expired);
  expect(send).toHaveBeenCalledTimes(2);
  expect(native.postMessage).toHaveBeenCalledTimes(2);
});

it('[AC-F1-01b#23] 10403/h5_read_only 清除令牌、本次失败原样返回、不重发也不拉起登录', async () => {
  const old = token('standard', 'old');
  const fresh = token('read_only', 'fresh');
  const native = tokenBridge(old, fresh);
  native.transport.methods = ['auth.getH5Token', 'auth.login', 'nav.open'];
  const manager = createH5TokenManager();
  const denied = { code: 10403, msg: 'please use the App page', data: { reason: 'h5_read_only' } };
  const send = vi.fn(async () => denied);
  await expect(manager.request('POST', send)).resolves.toEqual(denied);
  expect(send).toHaveBeenCalledExactlyOnceWith(old.token);
  expect(native.postMessage).toHaveBeenCalledTimes(1);
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(fresh);
  expect(native.postMessage.mock.calls.map(([request]) => request.method)).toEqual([
    'auth.getH5Token',
    'auth.getH5Token',
  ]);
});

it('[AC-F1-01b#24] 10002 续取降为只读后，重放返回 h5_read_only 同样清缓存且停止', async () => {
  const old = token('standard', 'old');
  const restricted = token('read_only', 'unknown-update-state');
  const next = token('read_only', 'next');
  const native = tokenBridge(old, restricted, next);
  const manager = createH5TokenManager();
  const denied = { code: 10403, msg: 'restricted', data: { reason: 'h5_read_only' } };
  const send = vi
    .fn<(value: string) => Promise<H5ApiResponse>>()
    .mockResolvedValueOnce({ code: 10002, msg: 'expired' })
    .mockResolvedValueOnce(denied);
  await expect(manager.request('POST', send)).resolves.toEqual(denied);
  expect(send.mock.calls).toEqual([[old.token], [restricted.token]]);
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(next);
  expect(native.postMessage).toHaveBeenCalledTimes(3);
});

it.each([
  { code: 10403, msg: 'other forbidden scope' },
  { code: 10403, msg: 'other reason', data: { reason: 'other' } },
  { code: 20001, msg: 'bad params', data: { reason: 'h5_read_only' } },
])('[AC-F1-01b#25] 其他失败 $code 不续取、不重放、不误认只读失效也不拉起登录', async (failure) => {
  const cached = token('standard', 'cached');
  const native = tokenBridge(cached);
  native.transport.methods = ['auth.getH5Token', 'auth.login', 'nav.open'];
  const manager = createH5TokenManager();
  const send = vi.fn(async () => failure);
  await expect(manager.request('GET', send)).resolves.toEqual(failure);
  expect(send).toHaveBeenCalledExactlyOnceWith(cached.token);
  await expect(manager.getToken({ forWrite: false })).resolves.toEqual(cached);
  expect(native.postMessage).toHaveBeenCalledTimes(1);
});

it('[AC-F1-01b#26] 只读写前续取失败时，不携带旧令牌发出请求', async () => {
  let acquisitions = 0;
  const native = installBridge(['auth.getH5Token'], (request) => {
    acquisitions += 1;
    return acquisitions === 1
      ? { id: request.id, code: 0, msg: '', data: token('read_only', 'old') }
      : { id: request.id, code: 90401, msg: 'logged out' };
  });
  const manager = createH5TokenManager();
  await manager.getToken({ forWrite: false });
  const send = vi.fn(async () => ({ code: 0, msg: '' }));
  await expect(outcome(() => manager.request('POST', send))).rejects.toMatchObject({ code: 90401 });
  expect(send).not.toHaveBeenCalled();
  expect(native.postMessage).toHaveBeenCalledTimes(2);
});

it('[AC-F1-01b#27] 10002 之后续取失败不重放请求，也不自行调用 auth.login', async () => {
  let acquisitions = 0;
  const native = installBridge(['auth.getH5Token', 'auth.login'], (request) => {
    acquisitions += 1;
    return acquisitions === 1
      ? { id: request.id, code: 0, msg: '', data: token('standard', 'old') }
      : { id: request.id, code: 90401, msg: 'logged out' };
  });
  const manager = createH5TokenManager();
  const send = vi.fn(async () => ({ code: 10002, msg: 'expired' }));
  await expect(outcome(() => manager.request('GET', send))).rejects.toMatchObject({ code: 90401 });
  expect(send).toHaveBeenCalledTimes(1);
  expect(native.postMessage.mock.calls.map(([request]) => request.method)).toEqual([
    'auth.getH5Token',
    'auth.getH5Token',
  ]);
});

it('[AC-F1-01b#28] 原生不支持取令牌时先探测并返回 90001，不调用传输层或业务请求', async () => {
  const native = installBridge(['auth.getUser']);
  const manager = createH5TokenManager();
  const send = vi.fn(async () => ({ code: 0, msg: '' }));
  await expect(outcome(() => manager.request('GET', send))).rejects.toMatchObject({ code: 90001 });
  expect(native.postMessage).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it('[AC-F1-01b#29] App 外令牌 manager 返回 90001，不发送业务请求', async () => {
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  const manager = createH5TokenManager();
  const send = vi.fn(async () => ({ code: 0, msg: '' }));
  await expect(outcome(() => manager.request('GET', send))).rejects.toMatchObject({ code: 90001 });
  expect(send).not.toHaveBeenCalled();
});
