// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createConformanceShell } from '../../../../apps/h5/src/entries/conformance/shell.ts';
import {
  buildCaseTable,
  paramsForCase,
} from '../../../../apps/h5/src/entries/conformance/cases.ts';
import {
  assertResultSchema,
  blockedLinkVariants,
  caseUrl,
  contract,
  installBridge,
  result,
} from './kit.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, '__RESULT__');
  window.history.replaceState(null, '', '/');
});

it.each(Object.entries(contract.apps).filter(([, app]) => app.trade_only))(
  '[AC-F1-01d-NEGATIVE#1] ext.openApp 对 trade_only 目标 %s 发出真实参数并记录 90403',
  async (target) => {
    const row = buildCaseTable().find(
      (candidate) =>
        candidate.method === 'ext.openApp' &&
        candidate.category === 'negative' &&
        'code' in candidate.expect &&
        candidate.expect.code === 90403 &&
        (paramsForCase(candidate) as { target: string }).target === target,
    );
    expect(row).toBeDefined();
    const native = installBridge((request) => ({ id: request.id, code: 90403, msg: '' }));
    window.history.replaceState(null, '', `/?cases=${encodeURIComponent(row!.id)}`);
    const page = render(createConformanceShell());
    if (row!.trigger === 'tap') {
      expect(native.postMessage).not.toHaveBeenCalled();
      const button = page.container.querySelector<HTMLButtonElement>(
        `button[data-case-id="${row!.id}"]`,
      );
      expect(button).not.toBeNull();
      fireEvent.click(button!);
    }
    await waitFor(() => expect(result().cases[0]?.pass).toBe(true));
    expect(native.postMessage).toHaveBeenCalledTimes(1);
    expect(native.postMessage.mock.calls[0]?.[0]).toMatchObject({
      method: 'ext.openApp',
      params: paramsForCase(row!),
    });
    expect(result().cases[0]?.outcome).toEqual({ ok: false, code: 90403 });
    assertResultSchema(result());
  },
);

it.each(contract.bridgeErrorCodes)(
  '[AC-F1-01d-NEGATIVE#2] normal 的真实失败码 %s 不被吞掉、改写或按预期伪造',
  async (code) => {
    const native = installBridge((request) => ({
      id: request.id,
      code,
      msg: 'private-error-message',
      data: { token: 'private-error-token' },
    }));
    window.history.replaceState(null, '', '/?cases=app.getEnv%2Fnormal');
    render(createConformanceShell());
    await waitFor(() => expect(result().status).toBe('done'));
    expect(native.postMessage).toHaveBeenCalledTimes(1);
    expect(result().cases[0]).toMatchObject({
      expect: { ok: true },
      outcome: { ok: false, code },
      pass: false,
    });
    expect(result().summary).toEqual({ total: 1, passed: 0, failed: 1, pending: 0 });
    expect(JSON.stringify(result())).not.toContain('private-error');
    assertResultSchema(result());
  },
);

it('[AC-F1-01d-NEGATIVE#3] 无手势用例意外成功时必须判失败，不能只看已经调用', async () => {
  const native = installBridge();
  window.history.replaceState(null, '', '/?cases=clipboard.write%2Fno_gesture');
  const page = render(createConformanceShell());
  await waitFor(() => expect(result().status).toBe('done'));
  expect(native.postMessage).toHaveBeenCalledTimes(1);
  expect(page.container.querySelector('button[data-case-id]')).toBeNull();
  expect(result().cases[0]).toMatchObject({
    expect: { code: 90404 },
    outcome: { ok: true },
    pass: false,
  });
  assertResultSchema(result());
});

it.each(
  ['ext.openBrowser', 'share.open'].flatMap((method) =>
    blockedLinkVariants.map((variant) => ({ method, ...variant })),
  ),
)(
  '[AC-F1-01d-NEGATIVE#4] $method/$variant 原始 URL 传给桥，拒绝结果为 90403',
  async ({ method, url }) => {
    const row = buildCaseTable().find(
      (candidate) =>
        candidate.method === method &&
        candidate.category === 'negative' &&
        'code' in candidate.expect &&
        candidate.expect.code === 90403 &&
        caseUrl(candidate, paramsForCase(candidate)) === url,
    );
    expect(row).toBeDefined();
    const native = installBridge((request) => ({ id: request.id, code: 90403, msg: '' }));
    window.history.replaceState(null, '', `/?cases=${encodeURIComponent(row!.id)}`);
    const page = render(createConformanceShell());
    if (row!.trigger === 'tap') {
      expect(native.postMessage).not.toHaveBeenCalled();
      const button = page.container.querySelector<HTMLButtonElement>(
        `button[data-case-id="${row!.id}"]`,
      );
      expect(button).not.toBeNull();
      fireEvent.click(button!);
    }
    await waitFor(() => expect(result().cases[0]?.pass).toBe(true));
    expect(native.postMessage).toHaveBeenCalledTimes(1);
    expect(native.postMessage.mock.calls[0]?.[0]).toMatchObject({
      method,
      params: paramsForCase(row!),
    });
    expect(caseUrl(row!, native.postMessage.mock.calls[0]?.[0].params)).toBe(url);
    expect(result().cases[0]?.outcome).toEqual({ ok: false, code: 90403 });
    assertResultSchema(result());
  },
);
