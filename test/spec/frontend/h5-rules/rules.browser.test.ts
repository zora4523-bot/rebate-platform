/// <reference types="@vitest/browser-playwright" />
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { RulesPage } from '../../../../apps/h5/src/entries/app/pages/rules/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import { BODY_TEXT, CDN, server } from './fixtures.ts';

let root: Root | undefined;
let client: ReturnType<typeof createQueryClient> | undefined;
let viewport: { width: number; height: number };
let originalStyle: string | null;

beforeEach(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  originalStyle = document.documentElement.getAttribute('style');
  await page.viewport(390, 844);
});

afterEach(async () => {
  root?.unmount();
  root = undefined;
  client?.clear();
  client = undefined;
  document.body.replaceChildren();
  if (originalStyle === null) document.documentElement.removeAttribute('style');
  else document.documentElement.setAttribute('style', originalStyle);
  await page.viewport(viewport.width, viewport.height);
});

function mount(): HTMLElement {
  const container = document.createElement('main');
  container.style.fontFamily = 'var(--font-family-system)';
  document.body.append(container);
  let failure: unknown;
  root = createRoot(container, {
    onUncaughtError: (error) => {
      failure = error;
    },
  });
  client = createQueryClient();
  flushSync(() =>
    root?.render(
      createQueryProvider(
        createElement(RulesPage, {
          api: server().api,
          mediaCdnOrigin: CDN,
        }),
        client!,
      ),
    ),
  );
  if (failure !== undefined) throw failure;
  return container;
}

for (const large of [false, true]) {
  it(`[AC-F1-03a-BROWSER#${large ? 2 : 1}] h5-rules-${large ? 'large-text' : 'page'}`, async () => {
    // Emulate enlarged system text by doubling the root font; rem tokens scale with it.
    if (large) document.documentElement.style.fontSize = '200%';
    const container = mount();
    const title = page.getByRole('heading', { name: '返利规则', level: 1 });
    const body = page.getByText(BODY_TEXT, { exact: true });
    await expect.element(title).toBeVisible();
    await expect.element(body).toBeVisible();
    await expect.element(page.getByText('提现规则', { exact: true })).toBeVisible();
    await expect.element(page.getByText('订单找回', { exact: true })).toBeVisible();
    await document.fonts.ready;
    // DOM probes keep all browser assertions on expect.element (no polling matcher).
    const probe = document.createElement('span');
    const bodyElement = body.element();
    probe.dataset.largeText = String(
      !large || Number.parseFloat(getComputedStyle(bodyElement).fontSize) >= 28,
    );
    probe.dataset.fitsWidth = String(
      container.scrollWidth <= 390 && document.documentElement.scrollWidth <= 390,
    );
    document.body.append(probe);
    await expect.element(probe).toHaveAttribute('data-large-text', 'true');
    await expect.element(probe).toHaveAttribute('data-fits-width', 'true');
    const screenshot = await page.screenshot({ fullPage: true });
    probe.dataset.screenshotNameMatches = String(
      screenshot
        .split(/[\\/]/)
        .at(-1)
        ?.includes(`h5-rules-${large ? 'large-text' : 'page'}`),
    );
    await expect.element(probe).toHaveAttribute('data-screenshot-name-matches', 'true');
    probe.remove();
  });
}
