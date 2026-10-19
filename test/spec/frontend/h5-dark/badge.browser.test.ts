/// <reference types="@vitest/browser-playwright" />
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { PlatformBadge } from '../../../../apps/h5/src/components/platform/index.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import tokenSource from '../../../../contracts/design-tokens.json?raw';
import replacementPng from '../../../../apps/h5/src/components/platform/assets/jd.png?no-inline';

const tokens = JSON.parse(tokenSource) as {
  tokens: { color: { source: { background: { value: string; dark: string } } } };
};
const placeholders = ['alipay', 'wechat', 'wechat_pay', 'tmall', 'wecom'] as const;
const official = ['taobao', 'jd', 'pdd'] as const;
let root: Root | undefined;
let originalTheme: string | null;
let viewport: { width: number; height: number };
let systemDarkStyle: HTMLStyleElement | undefined;

beforeEach(async () => {
  originalTheme = document.documentElement.getAttribute('data-theme');
  viewport = { width: innerWidth, height: innerHeight };
  await page.viewport(390, 844);
});

afterEach(async () => {
  root?.unmount();
  root = undefined;
  vi.restoreAllMocks();
  systemDarkStyle?.remove();
  systemDarkStyle = undefined;
  document.body.replaceChildren();
  if (originalTheme === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', originalTheme);
  await page.viewport(viewport.width, viewport.height);
});

type RGB = readonly [number, number, number];

function darkMediaContents(rules: CSSRuleList): string {
  return Array.from(rules, (rule) => {
    if (rule instanceof CSSMediaRule && /prefers-color-scheme:\s*dark/.test(rule.conditionText)) {
      // Keep the actual selectors/declarations, especially :not([data-theme="light"]).
      return Array.from(rule.cssRules, (child) => child.cssText).join('\n');
    }
    if ('cssRules' in rule) {
      const contents = darkMediaContents((rule as CSSGroupingRule).cssRules);
      // Preserve cascade layers, @supports and nested selectors around a dark media rule.
      return contents === ''
        ? ''
        : `${rule.cssText.slice(0, rule.cssText.indexOf('{'))}{${contents}}`;
    }
    return '';
  })
    .filter(Boolean)
    .join('\n');
}

function emulateSystemDark(): void {
  // Browser mode has no configured media command. Activate the shipped CSS media
  // contents without setting data-theme or changing tokens/configuration.
  const contents = Array.from(document.styleSheets, (sheet) => darkMediaContents(sheet.cssRules));
  systemDarkStyle = document.createElement('style');
  systemDarkStyle.textContent = contents.filter(Boolean).join('\n');
  document.head.append(systemDarkStyle);
}

function interceptReplacement(url: string): void {
  // As in h5-platform-badge/images.ts, intercept BOTH the preload Image.src setter
  // and React's attribute writes. Only substitute bytes with a bundled PNG; real
  // load/decode events and the component's remote-selection state still run.
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
  const setAttribute = Element.prototype.setAttribute;
  function mapped(image: HTMLImageElement, value: string): string {
    if (value === url) {
      setAttribute.call(image, 'data-remote-fixture', url);
      setAttribute.call(image, 'data-testid', 'loaded-remote-icon');
      return replacementPng;
    }
    image.removeAttribute('data-remote-fixture');
    if (image.getAttribute('data-testid') === 'loaded-remote-icon')
      image.removeAttribute('data-testid');
    return value;
  }
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
    this: HTMLImageElement,
    value: string,
  ) {
    src.set!.call(this, mapped(this, value));
  });
  vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (
    this: Element,
    name: string,
    value: string,
  ) {
    setAttribute.call(
      this,
      name,
      this instanceof HTMLImageElement && name.toLowerCase() === 'src'
        ? mapped(this, value)
        : value,
    );
  });
}

function luminance(rgb: RGB): number {
  const linear = rgb.map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function contrast(first: RGB, second: RGB): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function tokenRgb(value: string): RGB {
  // Source background tokens are opaque sRGB hex; do not obtain the oracle from CSS.
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

async function decoded(image: HTMLImageElement): Promise<void> {
  // A broken image must produce an assertion failure, not an unhandled decode rejection.
  const loaded = await image.decode().then(
    () => true,
    () => false,
  );
  image.dataset.decoded = String(loaded && image.naturalWidth > 0);
  await expect.element(image).toHaveAttribute('data-decoded', 'true');
}

async function paintedContrast(icon: Element, background: RGB): Promise<number> {
  // Screenshot just the icon, not the adjacent readable platform label. This measures
  // real composited pixels (including opacity/currentColor) for BOTH <img> and inline SVG.
  // Reading the browser's screenshot also avoids re-serializing an inline SVG and losing
  // its inherited CSS, or accidentally lending the page's color to an external image.
  const path = await page.screenshot({ element: icon });
  const base64 = await commands.readFile(path, 'base64');
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await decoded(image);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  canvas.dataset.contextAvailable = String(context !== null);
  await expect.element(canvas).toHaveAttribute('data-context-available', 'true');
  context!.drawImage(image, 0, 0);
  const pixels = context!.getImageData(0, 0, canvas.width, canvas.height).data;
  const ratios: number[] = [];
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3]! / 255;
    const rgb = background.map(
      (channel, index) => pixels[offset + index]! * alpha + channel * (1 - alpha),
    ) as [number, number, number];
    const ratio = contrast(rgb, background);
    // Ignore the flat background and nearly transparent antialiasing fringe. Use the
    // upper decile of painted pixels instead of one brightest pixel or a fixed coordinate:
    // thin strokes and glyphs need not occupy the same pixels in the two valid repairs.
    if (ratio > 1.05) ratios.push(ratio);
  }
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length * 0.9)] ?? 1;
}

it('[AC-F1-01r-BADGE#1] [AC-F1-01r-BADGE#2] 浅深占位图对比度至少 3:1，官方 PNG 保持原色', async () => {
  const remoteUrl = 'https://media.example.test/platform/h5-dark-wechat.png';
  interceptReplacement(remoteUrl);
  const container = document.createElement('main');
  document.body.append(container);
  root = createRoot(container);
  flushSync(() =>
    root?.render(
      createElement(
        'section',
        null,
        ...[...placeholders, ...official].map((platform) =>
          createElement(
            'div',
            { key: platform, 'data-platform': platform },
            createElement(PlatformBadge, { platform }),
          ),
        ),
        createElement(
          'div',
          { 'data-platform': 'wechat-remote' },
          createElement(PlatformBadge, {
            platform: 'wechat',
            remote: { url: remoteUrl, sha256: 'a'.repeat(64), version: 1 },
          }),
        ),
      ),
    ),
  );
  await document.fonts.ready;
  const probe = document.createElement('output');
  document.body.append(probe);
  const failures: string[] = [];
  // Select the displayed replacement, not the detached preloader or built-in fallback.
  const remoteLocator = page.getByTestId('loaded-remote-icon');
  await expect.element(remoteLocator).toBeVisible();
  await expect.element(remoteLocator).toHaveAttribute('data-remote-fixture', remoteUrl);
  await expect.element(remoteLocator).toHaveAttribute('src', replacementPng);

  for (const scenario of [
    { name: 'host-dark', theme: 'dark', systemDark: false },
    { name: 'host-light', theme: 'light', systemDark: false },
    { name: 'system-dark', theme: null, systemDark: true },
    { name: 'system-dark-host-light', theme: 'light', systemDark: true },
  ] as const) {
    if (scenario.systemDark && systemDarkStyle === undefined) emulateSystemDark();
    if (scenario.theme === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', scenario.theme);
    const theme = scenario.theme ?? 'dark';
    const background = tokenRgb(
      tokens.tokens.color.source.background[theme === 'dark' ? 'dark' : 'value'],
    );

    // BADGE#2 already passes on main. Keep it in this combined regression case, before
    // BADGE#1's final assertion, so there is no independently green "red phase" test.
    for (const platform of [...official, 'wechat-remote']) {
      const image = container.querySelector<HTMLImageElement>(`[data-platform="${platform}"] img`);
      await expect.element(image).toBeVisible();
      if (platform === 'wechat-remote') {
        await expect.element(image).toHaveAttribute('data-remote-fixture', remoteUrl);
        await expect.element(image).toHaveAttribute('src', replacementPng);
      }
      await decoded(image!);
      for (let element: Element | null = image; element !== null; element = element.parentElement) {
        const style = getComputedStyle(element);
        probe.style.filter = style.filter;
        probe.style.mixBlendMode = style.mixBlendMode;
        probe.style.opacity = style.opacity;
        await expect
          .element(probe)
          .toHaveStyle({ filter: 'none', mixBlendMode: 'normal', opacity: '1' });
      }
    }

    for (const platform of placeholders) {
      const badge = container.querySelector<HTMLElement>(`[data-platform="${platform}"] > *`);
      await expect.element(badge).toBeVisible();
      probe.style.backgroundColor = getComputedStyle(badge!).backgroundColor;
      await expect.element(probe).toHaveStyle({ backgroundColor: `rgb(${background.join(', ')})` });
      const icon = badge!.querySelector<HTMLImageElement | SVGSVGElement>('img, svg');
      await expect.element(icon).toBeVisible();
      if (icon instanceof HTMLImageElement) await decoded(icon);
      const ratio = await paintedContrast(icon!, background);
      if (ratio < 3) failures.push(`${platform}/${scenario.name}: ${ratio.toFixed(3)}:1 < 3:1`);
    }
  }

  // Gather both theme sources/all five platforms before failing; diagnostics name the actual
  // invisible icons. Current main fails here because external SVG currentColor is black.
  probe.textContent = failures.join('\n');
  await expect.element(probe).toBeEmptyDOMElement();
}, 30_000);
