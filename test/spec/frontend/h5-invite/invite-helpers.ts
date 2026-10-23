import { createElement, useEffect } from 'react';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import type { userEvent } from '@testing-library/user-event';
import { afterEach, expect, vi } from 'vitest';
import { InvitePage } from '../../../../apps/h5/src/entries/app/pages/invite/index.ts';
import {
  MemoryRouter,
  useLocation,
} from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import type { InviteServer } from './invite-fixtures.ts';
export { LOADING } from '../h5-notices/helpers.ts';

configure({ asyncUtilTimeout: 10_000 });
const clients: ReturnType<typeof createQueryClient>[] = [];
/** Every in-app location the router showed, in order (pathname + search). */
const visited: string[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  visited.splice(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function LocationProbe() {
  const location = useLocation();
  const here = location.pathname + location.search;
  useEffect(() => {
    visited.push(here);
  }, [location.key, here]);
  return createElement('output', { 'data-testid': 'invite-location', hidden: true }, here);
}

export function mount(api: H5ApiClient | null) {
  const client = createQueryClient();
  clients.push(client);
  return render(
    createQueryProvider(
      createElement(
        ApiProvider,
        { api },
        createElement(
          MemoryRouter,
          { initialEntries: ['/invite'] },
          createElement(InvitePage, {}),
          createElement(LocationProbe),
        ),
      ),
      client,
    ),
  );
}

/** Current in-app router location (pathname + search). */
export function currentLocation(): string {
  return screen.getByTestId('invite-location').textContent ?? '';
}

/** In-app locations visited after the first one (`/invite`). */
export function visitedLocations(): string[] {
  return visited.slice(1);
}

/** All buttons and links whose accessible name matches. */
export function controls(name: string | RegExp): HTMLElement[] {
  return [...screen.queryAllByRole('button', { name }), ...screen.queryAllByRole('link', { name })];
}

/** The single enabled button or link with this accessible name. */
export function entry(name: string | RegExp): HTMLElement {
  const found = controls(name);
  expect(found, `唯一可访问入口 ${String(name)}`).toHaveLength(1);
  return found[0]!;
}

export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}

/** Page text with whitespace removed (the location probe excluded). */
export function pageText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelector('[data-testid="invite-location"]')?.remove();
  return squash(clone.textContent);
}

/** A hint is shown either in the page or through the native toast (ui.toast). */
export function noticeShown(http: InviteServer, text: string): boolean {
  const toasts = http
    .calls('ui.toast')
    .map((request) => (request.params as { text?: unknown } | undefined)?.text);
  return squash(document.body.textContent).includes(squash(text)) || toasts.includes(text);
}

export async function expectNotice(http: InviteServer, text: string): Promise<void> {
  await waitFor(() => expect(noticeShown(http, text), `提示「${text}」`).toBe(true));
}

/** nav.open params whose route matches. */
export function navigations(http: InviteServer, route: string): Record<string, unknown>[] {
  return http
    .calls('nav.open')
    .map((request) => request.params as { route?: string; params?: Record<string, unknown> })
    .filter((params) => params.route === route)
    .map((params) => params.params ?? {});
}

/**
 * Article ids the page opened in the help centre: either through nav.open {route: Help} or
 * an in-app push to `/help?article_id=…` (the help page's own URL shape).
 */
export function openedHelpArticles(http: InviteServer): string[] {
  const viaBridge = navigations(http, 'Help').map((params) => String(params['article_id'] ?? ''));
  const viaRouter = visitedLocations()
    .map((location) => new URL(location, 'https://h5.example.invalid'))
    .filter((url) => url.pathname === '/help')
    .map((url) => url.searchParams.get('article_id') ?? '');
  return [...viaBridge, ...viaRouter];
}

/**
 * The 邀请规则 card: the smallest element holding both the card title (an element whose whole
 * text is the title) and its 【完整规则】 entry.
 */
export function ruleCard(title: string, fullEntry: RegExp): HTMLElement {
  const full = entry(fullEntry);
  const heading = screen
    .getAllByText(title)
    .find((element) => !element.contains(full) && element !== full);
  expect(heading, `规则卡标题「${title}」`).toBeDefined();
  let card: HTMLElement | null = heading!.parentElement;
  while (card !== null && !card.contains(full)) card = card.parentElement;
  expect(card, '规则卡同时含标题与完整规则入口').not.toBeNull();
  return card!;
}

/**
 * Text of the card's last rule: its last list item when the rules are a list, otherwise the card
 * text after the 【完整规则】 entry's text is taken out (whitespace removed either way).
 */
export function lastRule(card: HTMLElement, fullEntry: RegExp): string {
  const items = within(card).queryAllByRole('listitem');
  if (items.length > 0) return squash(items.at(-1)!.textContent);
  const full = within(card)
    .queryAllByRole('link', { name: fullEntry })
    .concat(within(card).queryAllByRole('button', { name: fullEntry }));
  let text = squash(card.textContent);
  for (const element of full) text = text.replace(squash(element.textContent), '');
  return text;
}

type User = ReturnType<typeof userEvent.setup>;

/**
 * Tap 【保存海报】; when the page first shows its own poster preview (PosterInvite), confirm the
 * save from inside that preview. Either way the save itself goes through media.saveImage.
 */
export async function savePoster(
  user: User,
  http: InviteServer,
  label: RegExp,
  poster: string,
): Promise<{ previewed: boolean }> {
  const shows = (): boolean =>
    Array.from(document.querySelectorAll('img')).some((img) => img.src === poster) ||
    http
      .calls('media.previewImage')
      .some((request) => ((request.params as { urls?: unknown[] }).urls ?? []).includes(poster));
  await user.click(entry(label));
  await waitFor(() =>
    expect(
      http.calls('media.saveImage').length > 0 || screen.queryByRole('dialog') !== null,
      '点保存海报后保存或出现海报预览',
    ).toBe(true),
  );
  let previewed = shows();
  if (http.calls('media.saveImage').length === 0) {
    const dialog = screen.getByRole('dialog');
    const buttons = within(dialog).getAllByRole('button', { name: /保存/ });
    await user.click(buttons[0]!);
    await waitFor(() => expect(http.calls('media.saveImage').length).toBeGreaterThan(0));
  }
  previewed ||= shows();
  return { previewed };
}
