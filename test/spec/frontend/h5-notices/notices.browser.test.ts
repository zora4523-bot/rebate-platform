/// <reference types="@vitest/browser-playwright" />
import { createElement, type ComponentType } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { NoticePage } from '../../../../apps/h5/src/entries/app/pages/notices/index.ts';
import { AgreementPage } from '../../../../apps/h5/src/entries/app/pages/agreements/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/notices/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import {
  AGREEMENT_BODY,
  agreements,
  defaultReply,
  list,
  NOTICE_BODY,
  notices,
  reply,
  server,
} from './fixtures.ts';

let root: Root | undefined;
let client: ReturnType<typeof createQueryClient> | undefined;
let viewport: { width: number; height: number };

beforeEach(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  await page.viewport(390, 844);
});

afterEach(async () => {
  root?.unmount();
  root = undefined;
  client?.clear();
  client = undefined;
  document.body.replaceChildren();
  await page.viewport(viewport.width, viewport.height);
});

const longSummary = '公告摘要需要保留两行，更多内容进入详情查看。'.repeat(12);

function mount(component: ComponentType<Record<string, never>>, path: string): HTMLElement {
  const http = server((url) =>
    url.pathname === '/v1/articles'
      ? reply(
          list([
            { ...notices[0]!, notice: { ...notices[0]!.notice, text: longSummary } },
            notices[1]!,
          ]),
        )
      : defaultReply(url),
  );
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
          { api: http.api },
          createElement(MemoryRouter, { initialEntries: [path] }, createElement(component, {})),
        ),
        client!,
      ),
    ),
  );
  if (failure !== undefined) throw failure;
  return container;
}

async function screenshot(container: HTMLElement, name: string): Promise<void> {
  await document.fonts.ready;
  const probe = document.createElement('span');
  probe.dataset.fitsWidth = String(
    container.scrollWidth <= 390 && document.documentElement.scrollWidth <= 390,
  );
  document.body.append(probe);
  await expect.element(probe).toHaveAttribute('data-fits-width', 'true');
  const filename = await page.screenshot({ fullPage: true });
  probe.dataset.namedScreenshot = String(filename.split(/[\\/]/).at(-1)?.includes(name));
  await expect.element(probe).toHaveAttribute('data-named-screenshot', 'true');
  probe.remove();
}

it('[AC-F1-03c-BROWSER#1] h5-notice-list', async () => {
  const container = mount(NoticePage, '/notice');
  await expect.element(page.getByText(notices[0]!.title, { exact: true })).toBeVisible();
  await expect.element(page.getByText(notices[1]!.title, { exact: true })).toBeVisible();
  await expect.element(page.getByText('没有更多公告了')).toBeVisible();
  const summary = page.getByText(longSummary, { exact: true });
  await expect.element(summary).toBeVisible();
  await document.fonts.ready;
  // Check rendered CSS in Chromium, rather than prescribing a Tailwind class name.
  let element: Element | null = summary.element();
  let clamped = false;
  while (element && element !== container) {
    const style = getComputedStyle(element);
    if (style.webkitLineClamp === '2' && style.overflow === 'hidden') {
      // Range line positions also work with line-height: normal; measure only the content box.
      const range = document.createRange();
      range.selectNodeContents(summary.element());
      const lineTops = [...new Set(Array.from(range.getClientRects(), (rect) => rect.top))].sort(
        (a, b) => a - b,
      );
      const lineHeight = (lineTops[1] ?? 0) - (lineTops[0] ?? 0);
      const contentHeight =
        element.getBoundingClientRect().height -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom) -
        Number.parseFloat(style.borderTopWidth) -
        Number.parseFloat(style.borderBottomWidth);
      clamped = lineHeight > 0 && contentHeight > 0 && contentHeight <= lineHeight * 2 + 1;
      break;
    }
    element = element.parentElement;
  }
  const probe = document.createElement('span');
  probe.dataset.twoLines = String(clamped);
  document.body.append(probe);
  await expect.element(probe).toHaveAttribute('data-two-lines', 'true');
  probe.remove();
  await screenshot(container, 'h5-notice-list');
});

it('[AC-F1-03c-BROWSER#2] h5-notice-detail', async () => {
  const container = mount(NoticePage, '/notice?article_id=z-maintenance');
  await expect
    .element(page.getByRole('heading', { name: notices[0]!.title, level: 1 }))
    .toBeVisible();
  await expect.element(page.getByText(NOTICE_BODY, { exact: true })).toBeVisible();
  await screenshot(container, 'h5-notice-detail');
});

it('[AC-F1-03c-BROWSER#3] h5-agreement', async () => {
  const container = mount(AgreementPage, '/agreement?type=privacy');
  await expect
    .element(page.getByRole('heading', { name: agreements[1]!.title, level: 1 }))
    .toBeVisible();
  await expect.element(page.getByText(AGREEMENT_BODY, { exact: true })).toBeVisible();
  await screenshot(container, 'h5-agreement');
});
