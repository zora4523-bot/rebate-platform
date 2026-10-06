// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RetryPage } from '../../../../apps/h5/src/components/retry/index.ts';
import * as texts from '../../../../apps/h5/src/shared/texts.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('[AC-F1-01e-RETRY#1] StateLoadFailed 有 alert、插图位、标题、说明与重试按钮', () => {
  const page = render(createElement(RetryPage, { onRetry: vi.fn() }));
  const alert = page.getByRole('alert');
  expect(within(alert).getByRole('heading').textContent).toBe('页面加载失败，请重试');
  expect(alert.querySelector('p')?.textContent).toBe('页面加载失败，请重试');
  expect(alert.querySelector('img, svg, [role="img"], [aria-hidden="true"]')).not.toBeNull();
  expect(within(alert).getByRole('button', { name: '重试' })).not.toBeNull();
});

it('[AC-F1-01e-RETRY#2] 未点击不重试，每次点击只调用一次回调', () => {
  const onRetry = vi.fn();
  const page = render(createElement(RetryPage, { onRetry }));
  expect(onRetry).not.toHaveBeenCalled();
  const button = page.getByRole('button', { name: '重试' });
  fireEvent.click(button);
  expect(onRetry).toHaveBeenCalledTimes(1);
  fireEvent.click(button);
  expect(onRetry).toHaveBeenCalledTimes(2);
});

it('[AC-F1-01e-RETRY#3] 标题、说明和按钮实际经 t(key)，不硬编码文案', () => {
  const translate = vi.spyOn(texts, 't').mockImplementation((key) => `translated:${key}`);
  const page = render(createElement(RetryPage, { onRetry: vi.fn() }));
  expect(page.getByRole('heading').textContent).toBe('translated:h5.load_failed');
  expect(page.getByRole('alert').querySelector('p')?.textContent).toBe('translated:h5.load_failed');
  expect(page.getByRole('button', { name: 'translated:h5.retry' })).not.toBeNull();
  expect(translate).toHaveBeenCalledWith('h5.load_failed');
  expect(translate).toHaveBeenCalledWith('h5.retry');
});

it('[AC-F1-01e-RETRY#4] 临时 h5.retry 文案可从现有字典入口读取', () => {
  expect(texts.t('h5.retry')).toBe('重试');
});

it('[AC-F1-01e-RETRY#5] 使用令牌颜色类名，不把字面颜色写进 DOM', () => {
  const page = render(createElement(RetryPage, { onRetry: vi.fn() }));
  const elements = [...page.getByRole('alert').querySelectorAll('*'), page.getByRole('alert')];
  const classes = elements.map((element) => element.getAttribute('class') ?? '').join(' ');
  expect(classes).toMatch(/\b(?:text|bg|border)-couli-(?:text|background|brand|button|border)-/);
  expect(classes).not.toMatch(
    /(?:text|bg|border)-(?:red|blue|green|gray|slate|white|black)(?:-|\b)/,
  );
  for (const element of elements) {
    for (const attribute of ['class', 'style', 'fill', 'stroke']) {
      expect(element.getAttribute(attribute) ?? '').not.toMatch(/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\(/i);
    }
  }
});
