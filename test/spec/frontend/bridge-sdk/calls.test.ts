// @vitest-environment jsdom
// 03 §5.3: v1 envelope, immediate/async responses, contract timeout and error propagation.
import { afterEach, expect, it, vi } from 'vitest';
import { call, has } from '@couli/bridge-sdk';
import { invoke } from '@couli/bridge-sdk/conformance';
import { contract, installBridge, outcome } from './kit.ts';
import type { BridgeResponse } from '@couli/bridge-sdk';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('[AC-F1-01b#8] 同步原生响应通过 Promise 返回结果，发送版本、唯一 id、方法和完整参数', async () => {
  const native = installBridge(['ui.toast']);
  const cap = has('ui.toast');
  expect(cap).not.toBeNull();
  if (cap === null) return;
  for (const text of ['one', 'two']) {
    const pending = call(cap, { text, duration: 'short' });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toEqual({});
  }
  expect(native.postMessage.mock.calls.map(([request]) => request)).toEqual([
    {
      v: 1,
      id: expect.any(String),
      method: 'ui.toast',
      params: { text: 'one', duration: 'short' },
    },
    {
      v: 1,
      id: expect.any(String),
      method: 'ui.toast',
      params: { text: 'two', duration: 'short' },
    },
  ]);
  const ids = native.postMessage.mock.calls.map(([request]) => request.id);
  expect(ids.every((id) => id.length > 0 && id.length <= 64)).toBe(true);
  expect(new Set(ids).size).toBe(2);
});

it('[AC-F1-01b#9] 异步响应可以乱序完成，各调用只得到自己的 data', async () => {
  const replies: (() => void)[] = [];
  const native = installBridge(
    ['app.getConfig'],
    (request) =>
      new Promise<BridgeResponse>((resolve) => {
        replies.push(() =>
          resolve({
            id: request.id,
            code: 0,
            msg: '',
            data: { values: { echo: request.params } },
          }),
        );
      }),
  );
  const cap = has('app.getConfig');
  expect(cap).not.toBeNull();
  if (cap === null) return;
  const first = call(cap, { keys: ['first'] });
  const second = call(cap, { keys: ['second'] });
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  replies[1]?.();
  await expect(second).resolves.toEqual({ values: { echo: { keys: ['second'] } } });
  replies[0]?.();
  await expect(first).resolves.toEqual({ values: { echo: { keys: ['first'] } } });
  expect(new Set(native.postMessage.mock.calls.map(([request]) => request.id)).size).toBe(2);
});

it('[AC-F1-01b#10] 商品引用 item_ref 与其他参数原样透传，不修改签名串', async () => {
  const native = installBridge(['trade.openProduct'], (request) => ({
    id: request.id,
    code: 0,
    msg: '',
    data: { opened: true },
  }));
  const cap = has('trade.openProduct');
  expect(cap).not.toBeNull();
  if (cap === null) return;
  const params = {
    platform: 'taobao',
    product_key: 'tb:123',
    item_ref: 'ref.+/=%2F&opaque',
  } as const;
  await call(cap, params);
  expect(native.postMessage).toHaveBeenCalledTimes(1);
  expect(native.postMessage.mock.calls[0]?.[0].params).toEqual(params);
});

it.each(contract.bridgeErrorCodes)(
  '[AC-F1-01b#11] 原生错误 %i 原样传回且不自动再次调用',
  async (code) => {
    const failure = { code, msg: 'native denial', data: { reason: 'fixture' } };
    const native = installBridge(['ui.toast'], (request) => ({ id: request.id, ...failure }));
    const cap = has('ui.toast');
    expect(cap).not.toBeNull();
    if (cap === null) return;
    await expect(outcome(() => call(cap, { text: 'x' }))).rejects.toMatchObject(failure);
    expect(native.postMessage).toHaveBeenCalledTimes(1);
  },
);

it('[AC-F1-01b#12] 有限超时采用契约 timeout_ms，到界限返回 90003，不重发', async () => {
  vi.useFakeTimers();
  const native = installBridge(['clipboard.read'], () => new Promise<BridgeResponse>(() => {}));
  const cap = has('clipboard.read');
  expect(cap).not.toBeNull();
  if (cap === null) return;
  let settled = false;
  const pending = call(cap, {});
  const observed = pending.then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  const timeout = contract.bridgeMethods['clipboard.read'].timeout_ms;
  await vi.advanceTimersByTimeAsync(timeout - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(observed).resolves.toMatchObject({ code: 90003, msg: expect.any(String) });
  expect(native.postMessage).toHaveBeenCalledTimes(1);
});

it('[AC-F1-01b#13] conformance 成功时遵循相同信封和结果约定', async () => {
  const native = installBridge(['ui.toast']);
  await expect(outcome(() => invoke('ui.toast', { text: 'check' }))).resolves.toEqual({});
  expect(native.postMessage.mock.calls[0]?.[0]).toMatchObject({
    v: 1,
    method: 'ui.toast',
    params: { text: 'check' },
  });
});
