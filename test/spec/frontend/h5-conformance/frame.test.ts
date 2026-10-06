// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createConformanceShell } from '../../../../apps/h5/src/entries/conformance/shell.ts';
import type { BridgeResponse } from '@couli/bridge-sdk';
import type {
  CaseOutcome,
  FrameReport,
} from '../../../../apps/h5/src/entries/conformance/model.ts';
import { assertResultSchema, installBridge, result } from './kit.ts';

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, '__RESULT__');
  window.history.replaceState(null, '', '/');
});

function framePage() {
  window.history.replaceState(null, '', '/?cases=frame%2Fnegative%2Fsubframe');
  const page = render(createConformanceShell());
  const frame = page.container.querySelector('iframe');
  expect(frame).not.toBeNull();
  const url = new URL(frame!.src, window.location.href);
  expect(url.origin).toBe(window.location.origin);
  expect(url.searchParams.get('frame')).toBe('child');
  return { ...page, frame: frame! };
}

function report(source: MessageEventSource | null, outcome: CaseOutcome): void {
  const data: FrameReport = { type: 'couli.bridge-conformance/frame', outcome };
  window.dispatchEvent(
    new MessageEvent('message', { data, origin: window.location.origin, source }),
  );
}

it.each([
  [{ ok: false, code: 90001 }, true],
  [{ ok: false, code: 90403 }, true],
  [{ ok: false, code: 90004 }, true],
  [{ ok: false, code: 90500 }, true],
  [{ ok: true }, false],
] as const)('[AC-F1-01d-FRAME#1] 父页记录子框架 $0，只有失败才通过', async (outcome, pass) => {
  const native = installBridge();
  const { frame } = framePage();
  expect(result().cases[0]).toMatchObject({
    outcome: null,
    pass: null,
    ms: null,
    expect: { ok: false },
  });
  act(() => report(frame.contentWindow, outcome));
  await waitFor(() => expect(result().status).toBe('done'));
  expect(result().cases[0]).toMatchObject({ id: 'frame/negative/subframe', outcome, pass });
  expect(native.postMessage).not.toHaveBeenCalled();
  assertResultSchema(result());
});

it('[AC-F1-01d-FRAME#2] 3 秒未收到子框架消息记 90003，晚到消息不改写结果', async () => {
  vi.useFakeTimers();
  installBridge();
  const { frame } = framePage();
  const child = frame.contentWindow;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2999);
  });
  expect(result().cases[0]?.outcome).toBeNull();
  expect(result().status).toBe('running');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(result().cases[0]).toMatchObject({ outcome: { ok: false, code: 90003 }, pass: true });
  expect(result().status).toBe('done');
  act(() => report(child, { ok: true }));
  expect(result().cases[0]?.outcome).toEqual({ ok: false, code: 90003 });
  assertResultSchema(result());
});

it('[AC-F1-01d-FRAME#3] 无关窗口或无关消息不能替代真实子框架结果', async () => {
  installBridge();
  const { frame } = framePage();
  act(() => {
    report(window, { ok: false, code: 90403 });
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        origin: window.location.origin,
        data: { type: 'unrelated', outcome: { ok: false, code: 90403 } },
      }),
    );
  });
  expect(result().cases[0]?.outcome).toBeNull();
  act(() => report(frame.contentWindow, { ok: true }));
  await waitFor(() => expect(result().status).toBe('done'));
  expect(result().cases[0]).toMatchObject({ outcome: { ok: true }, pass: false });
});

it.each([0, 90403, 90001] as const)(
  '[AC-F1-01d-FRAME#4] frame=child 只调一次 app.getEnv 并将 %s 成败发给父页',
  async (code) => {
    const secret = { token: 'child-private-token' };
    const native = installBridge((request): BridgeResponse => ({
      id: request.id,
      code,
      msg: '',
      data: secret,
    }));
    const postMessage = vi.fn();
    vi.stubGlobal('parent', { postMessage });
    window.history.replaceState(null, '', '/?frame=child&cases=nav.close%2Fnormal');
    const page = render(createConformanceShell());
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(native.postMessage).toHaveBeenCalledTimes(1);
    expect(native.postMessage.mock.calls[0]?.[0]).toMatchObject({
      method: 'app.getEnv',
      params: {},
    });
    expect(postMessage.mock.calls[0]?.[0]).toEqual({
      type: 'couli.bridge-conformance/frame',
      outcome: code === 0 ? { ok: true } : { ok: false, code },
    });
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain('child-private-token');
    expect(page.container.querySelectorAll('iframe, button[data-case-id]')).toHaveLength(0);
    expect(native.listeners.size).toBe(0);
  },
);

it('[AC-F1-01d-FRAME#5] 子框架未注入桥时仍发送 SDK 的 90001', async () => {
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  const postMessage = vi.fn();
  vi.stubGlobal('parent', { postMessage });
  window.history.replaceState(null, '', '/?frame=child');
  render(createConformanceShell());
  await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
  expect(postMessage.mock.calls[0]?.[0]).toEqual({
    type: 'couli.bridge-conformance/frame',
    outcome: { ok: false, code: 90001 },
  });
});
