/// <reference types="@vitest/browser-playwright" />
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { MessagesPage } from '../../../../apps/h5/src/entries/app/pages/messages/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import tokens from '../../../../contracts/design-tokens.json' with { type: 'json' };
import {
  deletion,
  list,
  message,
  messages,
  messagesServer,
  paid,
  reply,
  risk,
  texts,
  tracked,
  type InboxMessage,
} from './messages-fixtures.ts';

let root: Root | undefined;
let client: ReturnType<typeof createQueryClient> | undefined;
let viewport: { width: number; height: number };
let originalTheme: string | null;
let originalFontSize: string;
let systemDarkStyle: HTMLStyleElement | undefined;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00+08:00'));
  viewport = { width: innerWidth, height: innerHeight };
  originalTheme = document.documentElement.getAttribute('data-theme');
  originalFontSize = document.documentElement.style.fontSize;
  document.documentElement.removeAttribute('data-theme');
  await page.viewport(375, 844);
});

afterEach(async () => {
  root?.unmount();
  root = undefined;
  client?.clear();
  client = undefined;
  systemDarkStyle?.remove();
  systemDarkStyle = undefined;
  document.body.replaceChildren();
  document.documentElement.style.fontSize = originalFontSize;
  if (originalTheme === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', originalTheme);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await page.viewport(viewport.width, viewport.height);
});

function mount(items: InboxMessage[] = messages): HTMLElement {
  const http = messagesServer({ list: () => reply(list(items)) });
  const container = document.createElement('div');
  document.body.append(container);
  let failure: unknown;
  root = createRoot(container, {
    onUncaughtError: (error) => {
      failure = error;
    },
  });
  client = createQueryClient();
  flushSync(() =>
    root!.render(
      createQueryProvider(
        createElement(
          ApiProvider,
          { api: http.api },
          createElement(
            MemoryRouter,
            { initialEntries: ['/messages'] },
            createElement(MessagesPage, {}),
          ),
        ),
        client!,
      ),
    ),
  );
  if (failure !== undefined) throw failure;
  return container;
}

async function fitsWidth(container: HTMLElement, width: number): Promise<void> {
  await document.fonts.ready;
  const probe = document.createElement('span');
  probe.dataset.fitsWidth = String(
    container.scrollWidth <= width && document.documentElement.scrollWidth <= width,
  );
  document.body.append(probe);
  await expect.element(probe).toHaveAttribute('data-fits-width', 'true');
  probe.remove();
}

async function screenshot(container: HTMLElement, name: string): Promise<void> {
  await fitsWidth(container, 375);
  const filename = await page.screenshot({ fullPage: true });
  const probe = document.createElement('span');
  probe.dataset.namedScreenshot = String(filename.split(/[\\/]/).at(-1)?.includes(name));
  document.body.append(probe);
  await expect.element(probe).toHaveAttribute('data-named-screenshot', 'true');
  probe.remove();
}

function darkMediaContents(rules: CSSRuleList): string {
  return Array.from(rules, (rule) => {
    if (rule instanceof CSSMediaRule && /prefers-color-scheme:\s*dark/.test(rule.conditionText))
      return Array.from(rule.cssRules, (child) => child.cssText).join('\n');
    if ('cssRules' in rule) {
      const contents = darkMediaContents((rule as CSSGroupingRule).cssRules);
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
  // Same CSS-media technique as h5-dark / h5-ledger: activate the shipped system-dark branch.
  systemDarkStyle = document.createElement('style');
  systemDarkStyle.textContent = Array.from(document.styleSheets, (sheet) =>
    darkMediaContents(sheet.cssRules),
  ).join('\n');
  document.head.append(systemDarkStyle);
}

it('[AC-F1-04c-BROWSER#1] h5-messages', async () => {
  const container = mount();
  await expect.element(page.getByText(tracked.body, { exact: false })).toBeVisible();
  for (const item of [tracked, paid, risk, deletion]) {
    await expect.element(container).toMatchTextContent(item.title);
  }
  await expect.element(container).toMatchTextContent(/今天\s*09:05/);
  await expect.element(page.getByRole('button', { name: texts.readAll })).toBeVisible();
  await screenshot(container, 'h5-messages');
});

it('[AC-F1-04c-BROWSER#2] h5-messages-empty', async () => {
  const container = mount([]);
  await expect.element(page.getByText(texts.empty, { exact: true })).toBeVisible();
  await expect.element(container).toMatchTextContent(texts.emptyHint);
  await screenshot(container, 'h5-messages-empty');
});

it('[AC-F1-04c-BROWSER#3] h5-messages-dark', async () => {
  emulateSystemDark();
  const container = mount();
  await expect.element(page.getByText(tracked.body, { exact: false })).toBeVisible();
  await expect.element(container).toMatchTextContent(tracked.title);
  await expect.element(document.documentElement).not.toHaveAttribute('data-theme');
  const probe = document.createElement('span');
  probe.style.backgroundColor = tokens.tokens.color.background.canvas.dark;
  document.body.append(probe);
  await expect
    .element(document.body)
    .toHaveStyle({ backgroundColor: getComputedStyle(probe).backgroundColor });
  probe.dataset.darkBranch = String((systemDarkStyle?.textContent?.length ?? 0) > 0);
  await expect.element(probe).toHaveAttribute('data-dark-branch', 'true');
  probe.remove();
  await screenshot(container, 'h5-messages-dark');
});

it('[AC-F1-04c-BROWSER#4] 320 窄屏与两倍字号下长标题、长正文不横向溢出', async () => {
  await page.viewport(320, 844);
  document.documentElement.style.fontSize = '32px';
  const longBody =
    '你在拼多多下的订单已跟单，预估返利 ¥12.34，确认收货后按联盟结算周期入账，详情可在订单页查看';
  const container = mount([message({ title: '跟单成功'.repeat(12), body: longBody }), ...messages]);
  await expect.element(page.getByText(longBody, { exact: false })).toBeVisible();
  await expect.element(container).toMatchTextContent(tracked.body);
  await fitsWidth(container, 320);
});
