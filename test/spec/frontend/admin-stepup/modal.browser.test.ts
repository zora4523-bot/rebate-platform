/// <reference types="@vitest/browser-playwright" />
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import { StepUpModal } from '../../../../apps/admin/src/components/step-up/index.ts';
import '../../../../apps/admin/src/styles/admin.css';
import { CELL_SELECTOR, COPY, modalProps } from './fixtures.ts';

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

for (const tier of ['totp', 'sms'] as const) {
  it(`[AC-F1-06f-BROWSER#1] admin-stepup-${tier} 1440×1000 画板和单输入六格结构`, async () => {
    await page.viewport(1440, 1000);
    vi.useFakeTimers();
    const container = document.createElement('div');
    container.id = 'root';
    document.body.append(container);
    root = createRoot(container);
    // act propagates skeleton render errors to this test instead of an uncaught React task.
    await act(async () => {
      root!.render(
        createElement(
          StepUpModal,
          modalProps({
            tier,
            operation: tier === 'totp' ? '查看完整手机号' : '调账单提交并生效',
            details: [
              tier === 'totp'
                ? '对象：用户 U10023 · 本次查看会记入操作日志'
                : '对象：用户 U10023 · 调减 ¥1.20 · 结算核对更正（RECON_FIX）',
            ],
            maskedPhone: '137****3366',
            onResend: async () => ({ ok: true }),
          }),
        ),
      );
    });
    for (let second = 0; second < 2; second++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    // Freeze the resulting countdown at 58 for the screenshot, then allow locator timers.
    vi.useRealTimers();
    const dialog = page.getByRole('dialog', { name: COPY[tier].title });
    await expect.element(dialog).toBeVisible();
    const input = dialog.getByRole('textbox', { name: COPY[tier].label });
    // The real input is deliberately transparent over the six decorative cells.
    await expect.element(input).toBeInTheDocument();
    await act(async () => {
      await input.fill(tier === 'totp' ? '5179' : '308');
    });
    await expect.element(input).toHaveValue(tier === 'totp' ? '5179' : '308');
    await expect.element(input).toHaveAttribute('type', 'text');
    await expect.element(input).toHaveAttribute('maxlength', '6');
    await expect.element(input).toHaveAttribute('inputmode', 'numeric');
    await expect.element(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(dialog.element().querySelectorAll('input')).toHaveLength(1);
    const cells = dialog.element().querySelectorAll(CELL_SELECTOR);
    expect(cells).toHaveLength(6);
    for (const cell of cells) {
      expect(cell.closest('[aria-hidden="true"]')).not.toBeNull();
      const bounds = cell.getBoundingClientRect();
      expect(bounds.width).toBeCloseTo(44, 0);
      expect(bounds.height).toBeCloseTo(48, 0);
    }
    expect(Array.from(cells, (cell) => cell.textContent?.trim()).join('')).toBe(
      tier === 'totp' ? '5179' : '308',
    );
    const bounds = dialog.element().getBoundingClientRect();
    expect(bounds.width).toBeCloseTo(480, 0);
    expect(bounds.left + bounds.width / 2).toBeCloseTo(720, 0);
    expect(bounds.top + bounds.height / 2).toBeCloseTo(500, 0);
    await expect.element(dialog.getByRole('button', { name: '验证并继续' })).toBeDisabled();
    if (tier === 'sms') {
      await expect.element(dialog.getByText('137****3366', { exact: false })).toBeVisible();
      await expect
        .element(dialog.getByRole('button', { name: /重新发送.*58\s*秒/ }))
        .toBeDisabled();
    }
    await document.fonts.ready;
    const screenshot = await page.screenshot({ base64: true, fullPage: false });
    const fixedPath = screenshot.path.replace(/[^/]+$/, `admin-stepup-${tier}.png`);
    await commands.writeFile(fixedPath, screenshot.base64, 'base64');
    if (fixedPath !== screenshot.path) await commands.removeFile(screenshot.path);
    const saved = await commands.readFile(fixedPath, 'base64');
    expect(saved).toBe(screenshot.base64);
    const png = Uint8Array.from(atob(saved), (character) => character.charCodeAt(0));
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(1440);
    expect(view.getUint32(20)).toBe(1000);
  });
}

function ConditionalModal() {
  const [open, setOpen] = useState(false);
  return createElement(
    'div',
    null,
    createElement('button', { onClick: () => setOpen(true) }, '查看完整手机号'),
    open ? createElement(StepUpModal, modalProps({ onClose: () => setOpen(false) })) : null,
  );
}

it('[AC-S1-157#6][AC-F1-06f-BROWSER#2] 条件卸载后先解除真实 inert，再把焦点还给触发按钮', async () => {
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ConditionalModal));
  });
  const trigger = page.getByRole('button', { name: '查看完整手机号', exact: true });
  await expect.element(trigger).toBeVisible();
  await act(async () => {
    await trigger.click();
  });
  const dialog = page.getByRole('dialog', { name: COPY.totp.title });
  await expect.element(dialog).toBeVisible();
  expect(container.inert).toBe(true);
  expect(container.getAttribute('aria-hidden')).toBe('true');
  expect(dialog.element().closest('[inert], [aria-hidden="true"]')).toBeNull();
  const titleId = dialog.element().getAttribute('aria-labelledby');
  expect(titleId).toBeTruthy();
  await expect.element(document.getElementById(titleId!)!).toHaveFocus();
  // Real Chromium must reject focus on the inert trigger. jsdom cannot cover this failure.
  container.querySelector('button')!.focus();
  await expect.element(document.getElementById(titleId!)!).toHaveFocus();
  await act(async () => {
    await userEvent.keyboard('{Escape}');
  });
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  expect(container.inert).toBe(false);
  expect(container.hasAttribute('aria-hidden')).toBe(false);
});
