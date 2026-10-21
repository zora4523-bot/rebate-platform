/// <reference types="@vitest/browser-playwright" />
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { LedgerPage } from '../../../../apps/h5/src/entries/app/pages/ledger/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import tokens from '../../../../contracts/design-tokens.json' with { type: 'json' };
import {
  emptyHint,
  emptyTitle,
  endText,
  entries,
  inviteHint,
  inviteName,
  ledgerServer,
  list,
  reply,
  type LedgerEntry,
} from './ledger-fixtures.ts';

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

function mount(items: LedgerEntry[] = entries): HTMLElement {
  const http = ledgerServer(() => reply(list(items)));
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
            { initialEntries: ['/ledger'] },
            createElement(LedgerPage, {}),
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
  // Same CSS-media technique as h5-dark: browser config exposes no emulateMedia command.
  // Activate the shipped system-dark branch, preserving selectors/layers and host overrides.
  systemDarkStyle = document.createElement('style');
  systemDarkStyle.textContent = Array.from(document.styleSheets, (sheet) =>
    darkMediaContents(sheet.cssRules),
  ).join('\n');
  document.head.append(systemDarkStyle);
}

it('[AC-F1-04a-BROWSER#1] h5-ledger', async () => {
  const container = mount();
  await expect.element(page.getByText(inviteHint, { exact: false })).toBeVisible();
  await expect.element(container).toMatchTextContent(inviteHint);
  await expect.element(container).toMatchTextContent(inviteName);
  await expect.element(page.getByText(/2026\s*年\s*10\s*月/)).toBeVisible();
  await expect.element(page.getByText(/2026\s*年\s*9\s*月/)).toBeVisible();
  await expect.element(page.getByText(endText, { exact: true })).toBeVisible();
  await screenshot(container, 'h5-ledger');
});

it('[AC-F1-04a-BROWSER#2] h5-ledger-empty', async () => {
  const container = mount([]);
  await expect.element(page.getByText(emptyTitle, { exact: true })).toBeVisible();
  await expect.element(container).toMatchTextContent(emptyHint);
  await screenshot(container, 'h5-ledger-empty');
});

it('[AC-F1-04a-BROWSER#3] h5-ledger-dark', async () => {
  emulateSystemDark();
  const container = mount();
  await expect.element(page.getByText(inviteHint, { exact: false })).toBeVisible();
  await expect.element(container).toMatchTextContent(inviteHint);
  await expect.element(container).toMatchTextContent(inviteName);
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
  await screenshot(container, 'h5-ledger-dark');
});

it('[AC-F1-04a-BROWSER#4] 320 窄屏与两倍字号仍显示金额和说明且不横向溢出', async () => {
  await page.viewport(320, 844);
  document.documentElement.style.fontSize = '32px';
  const container = mount();
  await expect.element(page.getByText(inviteHint, { exact: false })).toBeVisible();
  await expect.element(container).toMatchTextContent(inviteHint);
  await expect.element(container).toMatchTextContent(/\+\s*[¥￥]\s*10\.01/);
  await expect.element(container).toMatchTextContent(/[−-]\s*[¥￥]\s*5\.67/);
  await fitsWidth(container, 320);
});
