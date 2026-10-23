/// <reference types="@vitest/browser-playwright" />
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { InvitePage } from '../../../../apps/h5/src/entries/app/pages/invite/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import tokens from '../../../../contracts/design-tokens.json' with { type: 'json' };
import {
  configAnswer,
  copy,
  inviteCode,
  inviteConfig,
  inviteServer,
  myInvite,
  reply,
  unavailable,
  type InviteServerOptions,
} from './invite-fixtures.ts';

let root: Root | undefined;
let client: ReturnType<typeof createQueryClient> | undefined;
let viewport: { width: number; height: number };
let originalTheme: string | null;
let originalFontSize: string;
let systemDarkStyle: HTMLStyleElement | undefined;

beforeEach(async () => {
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
  await page.viewport(viewport.width, viewport.height);
});

const rewardOn: InviteServerOptions = {
  config: () => configAnswer(inviteConfig({ enabled: true, amount_fen: 1000 })),
};

function mount(options: InviteServerOptions = {}): HTMLElement {
  const http = inviteServer(options);
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
            { initialEntries: ['/invite'] },
            createElement(InvitePage, {}),
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
  // Same CSS-media technique as h5-ledger / h5-dark: activate the shipped system-dark branch.
  systemDarkStyle = document.createElement('style');
  systemDarkStyle.textContent = Array.from(document.styleSheets, (sheet) =>
    darkMediaContents(sheet.cssRules),
  ).join('\n');
  document.head.append(systemDarkStyle);
}

const rewardSentence = copy.rewardTip.replace('{amount}', '¥10');

it('[AC-F1-05a-BROWSER#1] h5-invite', async () => {
  const container = mount();
  await expect.element(page.getByText(inviteCode, { exact: false }).first()).toBeVisible();
  await expect.element(page.getByRole('button', { name: /复制邀请码/ })).toBeVisible();
  await expect.element(page.getByRole('button', { name: /复制邀请链接/ })).toBeVisible();
  await expect.element(page.getByRole('button', { name: /保存海报/ })).toBeVisible();
  await expect.element(container).toMatchTextContent(copy.invitedCount);
  await expect.element(container).toMatchTextContent(copy.noReward);
  await screenshot(container, 'h5-invite');
});

it('[AC-F1-05a-BROWSER#2] h5-invite-reward', async () => {
  const container = mount(rewardOn);
  await expect.element(page.getByText(copy.rewardTitle, { exact: false })).toBeVisible();
  await expect.element(container).toMatchTextContent(rewardSentence);
  await expect.element(container).toMatchTextContent(copy.rewardRules);
  await expect.element(container).not.toMatchTextContent(copy.noReward);
  await screenshot(container, 'h5-invite-reward');
});

it('[AC-F1-05a-BROWSER#3] h5-invite-unavailable', async () => {
  const container = mount({ invite: () => reply(unavailable), ...rewardOn });
  await expect.element(page.getByText(copy.unavailable, { exact: false }).first()).toBeVisible();
  await expect.element(container).toMatchTextContent(copy.unavailableHint);
  await expect.element(container).toMatchTextContent(copy.invitedUnit.replace('{n}', '4'));
  await expect.element(page.getByRole('button', { name: /^\s*联系客服\s*$/ })).toBeVisible();
  await expect.element(container).toMatchTextContent(copy.rulesTitle);
  await expect.element(page.getByRole('button', { name: /复制邀请码/ })).not.toBeInTheDocument();
  await expect.element(page.getByText(copy.rewardTitle, { exact: false })).not.toBeInTheDocument();
  await screenshot(container, 'h5-invite-unavailable');
});

it('[AC-F1-05a-BROWSER#4] h5-invite-dark', async () => {
  emulateSystemDark();
  const container = mount(rewardOn);
  await expect.element(page.getByText(copy.rewardTitle, { exact: false })).toBeVisible();
  await expect.element(container).toMatchTextContent(inviteCode);
  await expect.element(container).toMatchTextContent(rewardSentence);
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
  await screenshot(container, 'h5-invite-dark');
});

it('[AC-F1-05a-BROWSER#5] 320 窄屏与两倍字号仍显示邀请码、按钮与奖励句且不横向溢出', async () => {
  await page.viewport(320, 844);
  document.documentElement.style.fontSize = '32px';
  const container = mount({
    invite: () => reply(myInvite({ direct_count: 12345 })),
    ...rewardOn,
  });
  await expect.element(page.getByText(copy.rewardTitle, { exact: false })).toBeVisible();
  await expect.element(container).toMatchTextContent(inviteCode);
  await expect.element(container).toMatchTextContent(copy.invitedUnit.replace('{n}', '12345'));
  await expect.element(page.getByRole('button', { name: /复制邀请链接/ })).toBeVisible();
  await fitsWidth(container, 320);
});
