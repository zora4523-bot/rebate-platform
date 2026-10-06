// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { BridgeEvent } from '@couli/bridge-sdk';
import { createConformanceShell } from '../../../../apps/h5/src/entries/conformance/shell.ts';
import {
  buildCaseTable,
  paramsForCase,
} from '../../../../apps/h5/src/entries/conformance/cases.ts';
import {
  assertResultSchema,
  deferred,
  forPlatform,
  installBridge,
  mvp,
  normalMethods,
  partial,
  platforms,
  rawContract,
  requiresTap,
  result,
  validParams,
} from './kit.ts';

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, '__RESULT__');
  window.history.replaceState(null, '', '/');
});

function select(...ids: string[]): void {
  window.history.replaceState(null, '', `/?cases=${encodeURIComponent(ids.join(','))}`);
}

function requiresGesture(method: string): boolean {
  return mvp.some(
    ([name, meta]) => name === method && (meta.level === 'L2' || meta.gesture_required),
  );
}

it.each(normalMethods)(
  '[AC-F1-01d-PAGE#1] %s 正常调用经真实 SDK；tap 在点击前零调用、完成后不泄露回包',
  async (method) => {
    const secret = {
      token: 'fixture-only-token',
      user: { phone: 'fixture-phone' },
      nested: { signing: 'fixture-only-signature' },
    };
    const native = installBridge((request) => ({
      id: request.id,
      code: 0,
      msg: 'private-native-message',
      data: secret,
    }));
    const id = `${method}/normal`;
    select(id);
    const page = render(createConformanceShell());
    const definition = buildCaseTable().find((row) => row.id === id)!;
    await waitFor(() => expect(result().cases.map((row) => row.id)).toEqual([id]));
    expect(result().bridge_present).toBe(true);
    if (definition.trigger === 'tap') {
      expect(native.postMessage).not.toHaveBeenCalled();
      expect(result().cases[0]).toMatchObject({ outcome: null, pass: null, ms: null });
      await waitFor(() => expect(result().status).toBe('done'));
      const button = page.container.querySelector<HTMLButtonElement>(
        `button[data-case-id="${id}"]`,
      );
      expect(button).not.toBeNull();
      fireEvent.click(button!);
    }
    await waitFor(() => expect(result().cases[0]?.outcome).toEqual({ ok: true }));
    expect(native.postMessage).toHaveBeenCalledTimes(1);
    expect(native.postMessage.mock.calls[0]?.[0]).toMatchObject({
      v: 1,
      method,
      params: paramsForCase(definition),
    });
    expect(typeof native.postMessage.mock.calls[0]?.[0].id).toBe('string');
    expect(result().cases[0]?.pass).toBe(true);
    expect(result().summary).toEqual({ total: 1, passed: 1, failed: 0, pending: 0 });
    assertResultSchema(result());
    const encoded = JSON.stringify(result());
    for (const forbidden of [
      'fixture-only-token',
      'fixture-phone',
      'fixture-only-signature',
      'private-native-message',
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
  },
);

it('[AC-F1-01d-PAGE#2] 页面初始 running，auto 回包后 done，不提前宣布完成', async () => {
  let finish: (() => void) | undefined;
  installBridge(
    (request) =>
      new Promise((resolve) => {
        finish = () => resolve({ id: request.id, code: 0, msg: '', data: {} });
      }),
  );
  select('app.getEnv/normal');
  render(createConformanceShell());
  expect(result().status).toBe('running');
  expect(result().summary).toEqual({ total: 1, passed: 0, failed: 0, pending: 1 });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  await act(async () => {
    finish!();
  });
  await waitFor(() => expect(result().status).toBe('done'));
  assertResultSchema(result());
});

it.each(platforms)(
  '[AC-F1-01d-PAGE#3] %s 默认只跑 auto，全部 tap 有按钮，harness 保持 pending',
  async (platform) => {
    vi.useFakeTimers();
    const native = installBridge(undefined, { platform });
    const page = render(createConformanceShell());
    const table = forPlatform(buildCaseTable(), platform);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const value = result();
    expect(native.environmentCalls).toHaveBeenCalledTimes(1);
    expect(native.transportPostMessage.mock.calls[0]?.[0]).toMatchObject({
      method: 'app.getEnv',
      params: {},
    });
    expect(value.status).toBe('done');
    expect(value.cases.map((row) => row.id)).toEqual(table.map((row) => row.id));
    expect(
      value.cases.map(({ id, method, category, expect, trigger, platforms }) => ({
        id,
        method,
        category,
        expect,
        trigger,
        ...(platforms ? { platforms } : {}),
      })),
    ).toEqual(table);
    expect(
      [...page.container.querySelectorAll('button[data-case-id]')]
        .map((button) => button.getAttribute('data-case-id'))
        .sort(),
    ).toEqual(
      table
        .filter((row) => row.trigger === 'tap')
        .map((row) => row.id)
        .sort(),
    );
    for (const row of value.cases) {
      if (row.trigger === 'auto') expect(row.outcome, row.id).not.toBeNull();
      else expect(row).toMatchObject({ outcome: null, pass: null, ms: null });
    }
    // Exact call multiset: negative parameter/gesture probes may use a side-effect method,
    // but a valid normal side-effect request must never be sent on page load.
    const expected = table
      .filter(
        (row) =>
          row.trigger === 'auto' &&
          row.id !== 'frame/negative/subframe' &&
          mvp.some(([method, meta]) => method === row.method && meta.since[platform] !== null),
      )
      .map((row) => JSON.stringify({ method: row.method, params: paramsForCase(row) }))
      .sort();
    expect(
      native.postMessage.mock.calls
        .map(([request]) => JSON.stringify({ method: request.method, params: request.params }))
        .sort(),
    ).toEqual(expected);
    for (const row of table.filter((row) => row.category === 'normal' && requiresTap(row.method))) {
      expect(row.trigger).toBe('tap');
    }
    assertResultSchema(value);
  },
);

it('[AC-F1-01d-PAGE#4] cases 选择只跑一条 auto、渲染一条 tap，未知 ID 可见', async () => {
  const native = installBridge();
  select('app.getEnv/normal', 'nav.close/normal', 'not-a-case');
  const page = render(createConformanceShell());
  await waitFor(() => expect(result().status).toBe('done'));
  expect(
    result()
      .cases.map((row) => row.id)
      .sort(),
  ).toEqual(['app.getEnv/normal', 'nav.close/normal']);
  expect(result().unknown_cases).toEqual(['not-a-case']);
  expect(native.postMessage.mock.calls.map(([request]) => request.method)).toEqual(['app.getEnv']);
  expect(
    [...page.container.querySelectorAll('button[data-case-id]')].map((button) =>
      button.getAttribute('data-case-id'),
    ),
  ).toEqual(['nav.close/normal']);
  expect(page.container.querySelector('iframe')).toBeNull();
  expect(result().summary).toEqual({ total: 2, passed: 1, failed: 0, pending: 1 });
});

it.each(['', 'unknown-case'])(
  '[AC-F1-01d-PAGE#5] 显式 cases=%s 不触发任何未选中的方法',
  async (query) => {
    const native = installBridge();
    select(query);
    const page = render(createConformanceShell());
    await waitFor(() => expect(result().status).toBe('done'));
    expect(result().cases).toEqual([]);
    expect(result().unknown_cases).toEqual(query ? [query] : []);
    expect(native.postMessage).not.toHaveBeenCalled();
    expect(page.container.querySelectorAll('button[data-case-id], iframe')).toHaveLength(0);
    assertResultSchema(result());
  },
);

it.each(mvp.filter(([, meta]) => meta.model === 'async' && meta.timeout_ms !== null))(
  '[AC-F1-01d-PAGE#6] 显式选择 %s/timeout 后需手势的方法等点击，采用契约超时',
  async (method, meta) => {
    vi.useFakeTimers();
    const native = installBridge(() => new Promise(() => {}));
    const id = `${method}/timeout`;
    select(id);
    const page = render(createConformanceShell());
    if (requiresGesture(method)) {
      // 等待超过完整超时窗口，验证 URL 选择本身不会启动调用或超时计时。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(meta.timeout_ms! + 1);
      });
      expect(native.postMessage).not.toHaveBeenCalled();
      expect(result().status).toBe('done');
      expect(result().cases[0]).toMatchObject({
        id,
        trigger: 'harness',
        outcome: null,
        pass: null,
        ms: null,
      });
      expect(result().summary).toEqual({ total: 1, passed: 0, failed: 0, pending: 1 });
      const button = page.container.querySelector<HTMLButtonElement>(
        `button[data-case-id="${id}"]`,
      );
      expect(button).not.toBeNull();
      fireEvent.click(button!);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(meta.timeout_ms! - 1);
    });
    expect(native.postMessage).toHaveBeenCalledTimes(1);
    expect(native.postMessage.mock.calls[0]?.[0].method).toBe(method);
    expect(result().cases[0]?.outcome).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result().cases[0]).toMatchObject({ outcome: { ok: false, code: 90003 }, pass: true });
    assertResultSchema(result());
  },
);

it.each(mvp.filter(([, meta]) => meta.level === 'L1' || meta.level === 'L2'))(
  '[AC-F1-01d-PAGE#7] %s 未登录 harness 的 90401 如实记录',
  async (method) => {
    const native = installBridge((request) => ({
      id: request.id,
      code: 90401,
      msg: '',
      data: { token: 'do-not-record' },
    }));
    select(`${method}/negative/logged_out`);
    render(createConformanceShell());
    await waitFor(() => expect(result().cases[0]?.pass).toBe(true));
    expect(native.postMessage).toHaveBeenCalledTimes(1);
    expect(native.postMessage.mock.calls[0]?.[0].method).toBe(method);
    expect(result().cases[0]?.outcome).toEqual({ ok: false, code: 90401 });
    expect(JSON.stringify(result())).not.toContain('do-not-record');
    assertResultSchema(result());
  },
);

it.each(mvp.filter(([, meta]) => meta.level === 'L2' || meta.gesture_required))(
  '[AC-F1-01d-PAGE#8] %s/no_gesture 不经点击直接调用，90404 才通过',
  async (method) => {
    const native = installBridge((request) => ({ id: request.id, code: 90404, msg: '' }));
    select(`${method}/no_gesture`);
    const page = render(createConformanceShell());
    await waitFor(() => expect(result().cases[0]?.pass).toBe(true));
    expect(native.postMessage).toHaveBeenCalledTimes(1);
    expect(page.container.querySelector('button[data-case-id]')).toBeNull();
    expect(result().cases[0]?.outcome).toEqual({ ok: false, code: 90404 });
  },
);

it('[AC-F1-01d-PAGE#9] bad_params 实际发送非法参数，不能只在页面伪造 90002', async () => {
  const native = installBridge((request) => ({
    id: request.id,
    code: validParams(rawContract.methods[request.method]!.params, request.params) ? 0 : 90002,
    msg: '',
  }));
  const badCases = forPlatform(buildCaseTable(), 'ios').filter(
    (row) => row.category === 'bad_params',
  );
  select(...badCases.map((row) => row.id));
  const page = render(createConformanceShell());
  await waitFor(() => expect(result().status).toBe('done'));
  expect(native.postMessage.mock.calls.map(([request]) => request.method).sort()).toEqual(
    badCases
      .filter((row) => !requiresGesture(row.method))
      .map((row) => row.method)
      .sort(),
  );
  for (const row of badCases.filter((row) => requiresGesture(row.method))) {
    expect(result().cases.find((candidate) => candidate.id === row.id)).toMatchObject({
      trigger: 'tap',
      outcome: null,
      pass: null,
      ms: null,
    });
    const button = page.container.querySelector<HTMLButtonElement>(
      `button[data-case-id="${row.id}"]`,
    );
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    await waitFor(() =>
      expect(result().cases.find((candidate) => candidate.id === row.id)).toMatchObject({
        outcome: { ok: false, code: 90002 },
        pass: true,
      }),
    );
  }
  expect(native.postMessage).toHaveBeenCalledTimes(badCases.length);
  expect(native.postMessage.mock.calls.map(([request]) => request.method).sort()).toEqual(
    badCases.map((row) => row.method).sort(),
  );
  expect(
    result().cases.every(
      (row) => row.pass === true && row.outcome?.ok === false && row.outcome.code === 90002,
    ),
  ).toBe(true);
  assertResultSchema(result());
});

it('[AC-F1-01d-PAGE#10] 未知方法及 P1 的 90001 经过 SDK，不调用未支持的原生方法', async () => {
  const native = installBridge();
  const rows = forPlatform(buildCaseTable(), 'ios').filter((row) => row.category === 'unsupported');
  select(...rows.map((row) => row.id));
  render(createConformanceShell());
  await waitFor(() => expect(result().status).toBe('done'));
  expect(result().cases).toHaveLength(
    deferred.length + partial.filter(([, meta]) => meta.since.ios === null).length + 1,
  );
  expect(
    result().cases.every(
      (row) => row.pass === true && row.outcome?.ok === false && row.outcome.code === 90001,
    ),
  ).toBe(true);
  expect(native.postMessage).not.toHaveBeenCalled();
  assertResultSchema(result());
});

it('[AC-F1-01d-PAGE#11] App 外 auto 桥调用全部如实记录 90001，不能按 expect 伪造通过', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  render(createConformanceShell());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(result().bridge_present).toBe(false);
  expect(result().status).toBe('done');
  expect(result().cases.map((row) => row.id)).toEqual(
    forPlatform(buildCaseTable(), null).map((row) => row.id),
  );
  const auto = result().cases.filter(
    (row) => row.trigger === 'auto' && row.id !== 'frame/negative/subframe',
  );
  expect(auto.length).toBeGreaterThan(0);
  for (const row of auto) expect(row.outcome, row.id).toEqual({ ok: false, code: 90001 });
  expect(result().summary.failed).toBeGreaterThan(0);
  assertResultSchema(result());
});

it('[AC-F1-01d-PAGE#12] 强制载入被拒 origin：原生 90403 回包不能算 normal 成功', async () => {
  const native = installBridge((request) => ({ id: request.id, code: 90403, msg: '' }));
  select('app.getEnv/normal');
  render(createConformanceShell());
  await waitFor(() => expect(result().status).toBe('done'));
  expect(native.postMessage).toHaveBeenCalledTimes(1);
  expect(result().cases[0]).toMatchObject({ outcome: { ok: false, code: 90403 }, pass: false });
  assertResultSchema(result());
});

it('[AC-F1-01d-PAGE#13] resume/pause 原样追加，其他事件不混入，卸载后解除订阅', async () => {
  const native = installBridge();
  select();
  const page = render(createConformanceShell());
  await waitFor(() => expect(result().status).toBe('done'));
  act(() => {
    native.emit({ event: 'app.resume', data: {} });
    native.emit({ event: 'app.pause', data: {} });
    native.emit({ event: 'app.resume', data: {} });
    native.emit({ event: 'auth.changed', data: { logged_in: true } });
    // 模拟违约的原生端，显式越过契约类型；页面必须原样保留，供三端 UI 测试发现。
    native.emit({
      event: 'app.pause',
      data: { unexpected: 'native-probe' },
    } as unknown as BridgeEvent);
  });
  expect(result().events).toEqual({
    'app.resume': [{}, {}],
    'app.pause': [{}, { unexpected: 'native-probe' }],
  });
  expect(result().summary).toEqual({ total: 0, passed: 0, failed: 0, pending: 0 });
  const events = structuredClone(result().events);
  page.unmount();
  native.emit({ event: 'app.resume', data: {} });
  expect(native.listeners.size).toBe(0);
  expect(result().events).toEqual(events);
});

it.each(platforms)(
  '[AC-F1-01d-PAGE#14] %s 的显式 cases 不能绕过平台限制，支持端运行、缺失端才记 90001',
  async (platform) => {
    const rows = buildCaseTable().filter((row) =>
      partial.some(([method]) => method === row.method),
    );
    expect(rows.length).toBeGreaterThan(0);
    const selected = forPlatform(rows, platform);
    const waitsForTap = (row: (typeof selected)[number]): boolean =>
      row.trigger === 'tap' || (row.category === 'timeout' && requiresGesture(row.method));
    const native = installBridge(undefined, { platform });
    select(...rows.map((row) => row.id), 'missing-platform-case');
    const page = render(createConformanceShell());
    await waitFor(() => expect(result().status).toBe('done'));
    expect(result().cases.map((row) => row.id)).toEqual(selected.map((row) => row.id));
    expect(result().unknown_cases).toEqual(['missing-platform-case']);
    expect(native.environmentCalls).toHaveBeenCalledTimes(1);
    expect(native.transportPostMessage.mock.calls[0]?.[0].method).toBe('app.getEnv');
    expect(
      [...page.container.querySelectorAll<HTMLButtonElement>('button[data-case-id]')]
        .map((button) => button.dataset.caseId)
        .sort(),
    ).toEqual(
      selected
        .filter(waitsForTap)
        .map((row) => row.id)
        .sort(),
    );
    const expectedCalls = selected.filter(
      (row) => !waitsForTap(row) && row.category !== 'unsupported',
    );
    expect(native.postMessage.mock.calls.map(([request]) => request.method).sort()).toEqual(
      expectedCalls.map((row) => row.method).sort(),
    );
    for (const row of result().cases) {
      if (row.category === 'unsupported') {
        expect(row).toMatchObject({ outcome: { ok: false, code: 90001 }, pass: true });
      } else if (waitsForTap(row)) {
        expect(row).toMatchObject({ outcome: null, pass: null, ms: null });
        const button = page.container.querySelector<HTMLButtonElement>(
          `button[data-case-id="${row.id}"]`,
        );
        expect(button).not.toBeNull();
        fireEvent.click(button!);
        await waitFor(() =>
          expect(result().cases.find((candidate) => candidate.id === row.id)).toMatchObject({
            outcome: { ok: true },
            // 此测试的原生端总是成功；超时 / 非法参数探针必须如实判为不通过。
            pass: row.category === 'normal',
          }),
        );
      } else expect(row.outcome).not.toBeNull();
    }
    expect(native.postMessage).toHaveBeenCalledTimes(
      selected.filter((row) => row.category !== 'unsupported').length,
    );
    assertResultSchema(result());
  },
);

it.each(['missing_platform', 'getenv_failure'] as const)(
  '[AC-F1-01d-PAGE#15] %s 时只运行、渲染不限制平台的用例',
  async (reason) => {
    const partialRows = buildCaseTable().filter((row) => row.platforms !== undefined);
    expect(partialRows.length).toBeGreaterThan(0);
    const native = installBridge(
      undefined,
      reason === 'getenv_failure' ? { code: 90403 } : { platform: null },
    );
    select(...partialRows.map((row) => row.id), 'app.getEnv/normal', 'nav.close/normal');
    const page = render(createConformanceShell());
    await waitFor(() => expect(result().status).toBe('done'));
    expect(
      result()
        .cases.map((row) => row.id)
        .sort(),
    ).toEqual(['app.getEnv/normal', 'nav.close/normal']);
    expect(result().unknown_cases).toEqual([]);
    expect(native.environmentCalls).toHaveBeenCalledTimes(1);
    expect(native.postMessage.mock.calls.map(([request]) => request.method)).toEqual([
      'app.getEnv',
    ]);
    expect(
      [...page.container.querySelectorAll('button[data-case-id]')].map((button) =>
        button.getAttribute('data-case-id'),
      ),
    ).toEqual(['nav.close/normal']);
    assertResultSchema(result());
  },
);

it('[AC-F1-01d-PAGE#16] app.getEnv 未回包前不能运行或渲染受平台限制的用例', async () => {
  const native = installBridge(undefined, { platform: 'harmony' });
  let finish: (() => void) | undefined;
  native.environmentCalls.mockImplementationOnce(
    (request) =>
      new Promise((resolve) => {
        finish = () => resolve({ id: request.id, code: 0, msg: '', data: { platform: 'harmony' } });
      }),
  );
  const rows = buildCaseTable().filter((row) => row.platforms !== undefined);
  select(...rows.map((row) => row.id));
  const page = render(createConformanceShell());
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(result().status).toBe('running');
  expect(native.postMessage).not.toHaveBeenCalled();
  expect(page.container.querySelector('button[data-case-id]')).toBeNull();
  await act(async () => {
    finish!();
  });
  await waitFor(() => expect(result().status).toBe('done'));
  expect(result().cases.map((row) => row.id)).toEqual(
    forPlatform(rows, 'harmony').map((row) => row.id),
  );
  expect(
    result().cases.every(
      (row) => row.pass === true && row.outcome?.ok === false && row.outcome.code === 90001,
    ),
  ).toBe(true);
  expect(native.postMessage).not.toHaveBeenCalled();
  assertResultSchema(result());
});
