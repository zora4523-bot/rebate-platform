/// <reference types="@vitest/browser-playwright" />
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { EarningsPage } from '../../../../apps/h5/src/entries/app/pages/earnings/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import tokens from '../../../../contracts/design-tokens.json' with { type: 'json' };
import {
  ALL,
  copy,
  earningsServer,
  NOW,
  platformNames,
  reply,
  zeroSummary,
  type EarningsServer,
} from './earnings-fixtures.ts';

let root: Root | undefined;
let client: ReturnType<typeof createQueryClient> | undefined;
let viewport: { width: number; height: number };
let originalTheme: string | null;
let originalFontSize: string;
let systemDarkStyle: HTMLStyleElement | undefined;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
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

function mount(http: EarningsServer = earningsServer()): HTMLElement {
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
            { initialEntries: ['/earnings'] },
            createElement(EarningsPage, {}),
          ),
        ),
        client!,
      ),
    ),
  );
  if (failure !== undefined) throw failure;
  return container;
}

async function ready(): Promise<void> {
  await expect.element(page.getByText(copy.self, { exact: true })).toBeVisible();
}

function controls(label: string): HTMLElement[] {
  return (['button', 'tab', 'radio'] as const).flatMap((role) =>
    page.getByRole(role, { name: label, exact: true }).elements(),
  ) as HTMLElement[];
}

/** The single option / pill whose accessible name is exactly `label` (button, tab or radio). */
async function control(label: string): Promise<HTMLElement> {
  // Pills come from app.getConfig, which may answer after the figures.
  await expect.poll(() => controls(label).length, { timeout: 10_000 }).toBe(1);
  return controls(label)[0]!;
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
  // Same CSS-media technique as h5-ledger / h5-dark: activate the shipped system-dark branch.
  systemDarkStyle = document.createElement('style');
  systemDarkStyle.textContent = Array.from(document.styleSheets, (sheet) =>
    darkMediaContents(sheet.cssRules),
  ).join('\n');
  document.head.append(systemDarkStyle);
}

/** Whether taps 21.5 px around the control's centre (a 43 px square) still land on it. */
function hitArea(element: HTMLElement): boolean {
  const target = element instanceof HTMLInputElement ? (element.labels?.[0] ?? element) : element;
  target.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = target.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  return [
    [x, y - 21.5],
    [x, y + 21.5],
    [x - 21.5, y],
    [x + 21.5, y],
  ].every(([px, py]) => {
    const hit = document.elementFromPoint(px!, py!);
    return hit !== null && (target.contains(hit) || element.contains(hit));
  });
}

it('[AC-F1-12a-BROWSER#1] h5-earnings', async () => {
  const container = mount();
  await ready();
  await expect.element(container).toMatchTextContent(copy.share);
  await expect.element(container).toMatchTextContent(copy.referralNote);
  await expect.element(container).toMatchTextContent(/-\s*¥\s*5\.2/);
  await expect.element(container).toMatchTextContent(/¥\s*10\.01/);
  await screenshot(container, 'h5-earnings');
});

it('[AC-F1-12a-BROWSER#2] h5-earnings-platform', async () => {
  const container = mount();
  await ready();
  await page.elementLocator(await control(platformNames.taobao)).click();
  await expect.element(page.getByText(copy.platformNote, { exact: true })).toBeVisible();
  await expect.element(container).toMatchTextContent(/¥\s*2\.22/);
  await screenshot(container, 'h5-earnings-platform');
});

it('[AC-F1-12a-BROWSER#3] h5-earnings-empty', async () => {
  const container = mount(earningsServer({ summary: () => reply(zeroSummary) }));
  await ready();
  const hint = copy.emptyHint.replace('{period}', copy.period.this_month);
  await expect.element(page.getByText(hint, { exact: false })).toBeVisible();
  await expect.element(container).toMatchTextContent(copy.referral);
  await screenshot(container, 'h5-earnings-empty');
});

it('[AC-F1-12a-BROWSER#4] h5-earnings-note', async () => {
  const container = mount();
  await ready();
  const buttons = page.getByRole('button', { name: new RegExp(copy.paidCount) }).elements();
  expect(buttons.length).toBeGreaterThan(0);
  await page.elementLocator(buttons[0]!).click();
  await expect.element(page.getByRole('dialog')).toBeVisible();
  await expect.element(page.getByRole('dialog')).toMatchTextContent(copy.paidCountHint);
  await screenshot(container, 'h5-earnings-note');
});

it('[AC-F1-12a-BROWSER#5] h5-earnings-dark', async () => {
  emulateSystemDark();
  const container = mount();
  await ready();
  await expect.element(container).toMatchTextContent(copy.referralNote);
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
  await screenshot(container, 'h5-earnings-dark');
});

it('[AC-F1-12a-BROWSER#6] 320 窄屏与两倍字号仍显示三栏金额且不横向溢出', async () => {
  await page.viewport(320, 844);
  document.documentElement.style.fontSize = '32px';
  const container = mount();
  await ready();
  await expect.element(container).toMatchTextContent(copy.referral);
  await expect.element(container).toMatchTextContent(/-\s*¥\s*5\.2/);
  await expect.element(container).toMatchTextContent(/¥\s*0\.61/);
  await fitsWidth(container, 320);
});

it('[AC-F1-12a-BROWSER#7] 平台胶囊命中区不小于 44（视觉 32 高也可，靠外扩命中区）', async () => {
  mount();
  await ready();
  for (const label of [ALL, platformNames.taobao, platformNames.jd]) {
    const probe = document.createElement('span');
    probe.dataset.label = label;
    probe.dataset.hit = String(hitArea(await control(label)));
    document.body.append(probe);
    await expect.element(probe).toHaveAttribute('data-hit', 'true');
    probe.remove();
  }
});
