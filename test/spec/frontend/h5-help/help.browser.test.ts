/// <reference types="@vitest/browser-playwright" />
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { HelpPage } from '../../../../apps/h5/src/entries/app/pages/help/index.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import { articles, BODY_HEADING, BODY_TEXT, fakeBridge, helpServer } from './fixtures.ts';

let root: Root | undefined;
let client: ReturnType<typeof createQueryClient> | undefined;
let viewport: { width: number; height: number };

beforeEach(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  await page.viewport(390, 980);
});

afterEach(async () => {
  root?.unmount();
  root = undefined;
  client?.clear();
  client = undefined;
  vi.restoreAllMocks();
  document.body.replaceChildren();
  await page.viewport(viewport.width, viewport.height);
});

function mount(detail: boolean): HTMLElement {
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
        createElement(
          ApiProvider,
          { api: helpServer().api },
          createElement(
            MemoryRouter,
            { initialEntries: [detail ? '/help?article_id=z-faq-47' : '/help'] },
            createElement(HelpPage, { bridge: fakeBridge().bridge }),
          ),
        ),
        client!,
      ),
    ),
  );
  if (failure !== undefined) throw failure;
  return container;
}

for (const [index, detail] of [false, true].entries()) {
  it(`[AC-F1-03b-BROWSER#${index + 1}] h5-help-${detail ? 'article' : 'home'}`, async () => {
    const container = mount(detail);
    if (detail) {
      await expect
        .element(page.getByRole('heading', { name: articles[0]!.title, level: 1 }))
        .toBeVisible();
      await expect
        .element(page.getByRole('heading', { name: BODY_HEADING, level: 2 }))
        .toBeVisible();
      await expect.element(page.getByText(BODY_TEXT, { exact: true })).toBeVisible();
      await expect.element(page.getByText('帮助', { exact: true })).toBeVisible();
      await expect.element(page.getByText(/更新于\s*2026-10-05/)).toBeVisible();
      await expect.element(page.getByText('还有问题，联系客服', { exact: true })).toBeVisible();
    } else {
      await expect.element(page.getByRole('heading', { name: '帮助中心' })).toBeVisible();
      await expect.element(page.getByRole('heading', { name: '常见问题' })).toBeVisible();
      for (const article of articles)
        await expect.element(page.getByText(article.title, { exact: true })).toBeVisible();
      await expect.element(page.getByText(/没找到答案/)).toBeVisible();
      await expect
        .element(page.getByRole('button', { name: '联系客服', exact: true }))
        .toBeVisible();
    }
    await document.fonts.ready;
    const probe = document.createElement('span');
    probe.dataset.fitsWidth = String(
      container.scrollWidth <= 390 && document.documentElement.scrollWidth <= 390,
    );
    document.body.append(probe);
    await expect.element(probe).toHaveAttribute('data-fits-width', 'true');
    const screenshot = await page.screenshot({ fullPage: true });
    probe.dataset.screenshotNameMatches = String(
      screenshot
        .split(/[\\/]/)
        .at(-1)
        ?.includes(`h5-help-${detail ? 'article' : 'home'}`),
    );
    await expect.element(probe).toHaveAttribute('data-screenshot-name-matches', 'true');
    probe.remove();
  });
}
