/// <reference types="@vitest/browser-playwright" />

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import './fixture.css';

let root: Root | undefined;

afterEach(() => {
  try {
    root?.unmount();
  } finally {
    root = undefined;
    document.body.replaceChildren();
  }
});

function mount(component: React.ReactNode): void {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(component);
}

function styledBlock(): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'p-4 text-[20px]';
  element.style.fontFamily = '"Noto Sans CJK SC"';
  element.textContent = '凑狸返利';
  document.body.append(element);
  return element;
}

it('[F1-01j] 真 Chromium 提供非零尺寸的文字块布局', () => {
  const element = document.createElement('div');
  element.textContent = '浏览器布局';
  element.style.display = 'block';
  document.body.append(element);

  expect(navigator.userAgent).toContain('Chrome');
  const bounds = element.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
});

it('[F1-01j] 视口可切换到 App 与后台设计稿尺寸', async () => {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  try {
    await page.viewport(375, 812);
    expect(window.innerWidth).toBe(375);
    expect(window.innerHeight).toBe(812);

    await page.viewport(1440, 900);
    expect(window.innerWidth).toBe(1440);
    expect(window.innerHeight).toBe(900);
  } finally {
    await page.viewport(originalWidth, originalHeight);
  }
});

it('[F1-01j] Noto CJK 中文字形与缺字框的像素不同', async () => {
  function glyphPixels(text: string): Uint8ClampedArray {
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    if (context === null) {
      expect.fail('真浏览器必须提供 Canvas 2D 上下文');
    }
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'black';
    context.font = '16px "Noto Sans CJK SC"';
    context.textBaseline = 'top';
    context.fillText(text, 8, 8);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  }

  await document.fonts.ready;
  expect(document.fonts.check('16px "Noto Sans CJK SC"', '凑狸返利')).toBe(true);
  const chinesePixels = glyphPixels('凑');
  const missingPixels = glyphPixels('\u{10FFFD}');
  expect(chinesePixels).not.toEqual(missingPixels);
});

it('[F1-01j] React 19 可挂载含中文文本的组件', async () => {
  function ChineseLabel(): React.ReactNode {
    return React.createElement('div', null, '凑狸返利');
  }

  expect(React.version.split('.')[0]).toBe('19');
  mount(React.createElement(ChineseLabel));
  await expect.element(page.getByText('凑狸返利', { exact: true })).toBeVisible();
});

it('[F1-01j] 元素断言等待组件在 300 毫秒后插入文字', async () => {
  function DelayedLabel(): React.ReactNode {
    const [visible, setVisible] = React.useState(false);
    React.useEffect(() => {
      const timer = window.setTimeout(() => setVisible(true), 300);
      return () => window.clearTimeout(timer);
    }, []);
    return visible ? React.createElement('div', null, '稍后出现') : null;
  }

  mount(React.createElement(DelayedLabel));
  expect(document.body.textContent).not.toContain('稍后出现');
  await expect.element(page.getByText('稍后出现', { exact: true })).toBeVisible();
});

it('[F1-01j] Tailwind 夹具生成内边距与任意字号样式', () => {
  const element = styledBlock();
  const style = window.getComputedStyle(element);
  expect(style.paddingTop).toBe('16px');
  expect(style.fontSize).toBe('20px');
});

it('[F1-01j] browser-env-cjk', async () => {
  const element = styledBlock();
  await document.fonts.ready;
  // 固定标题生成稳定文件名；不指定 path，以沿用项目配置的截图导出目录。
  const path = await page.screenshot({ element });
  expect(typeof path).toBe('string');
  expect(path.length).toBeGreaterThan(0);

  const base64 = await commands.readFile(path, 'base64');
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  expect(bytes.length).toBeGreaterThan(100);
  expect(Array.from(bytes.subarray(0, 8))).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
});
