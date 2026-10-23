// Shared jsdom harness for F1-06zu (D10-284): mounts the real shell (browser router) with or without
// `plannedOperations`, records every request the pages send, and checks the 「功能开发中」 state.
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, vi, type Mock } from 'vitest';
import { createAdminShell, type AdminAppOptions } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { BASE_URL, failure } from '../admin-unions/fixtures.ts';

configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 60_000;
/** The placeholder / button mark (registered in apps/admin/src/texts/shell.ts). */
export const PLANNED = '功能开发中';
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

/** operationIds the pages and buttons of this task depend on (contract operationIds). */
export const OPS = {
  dashboard: 'adminGetDashboard',
  listOrders: 'adminListOrders',
  getOrder: 'adminGetOrder',
  unionAccounts: 'adminListUnionAccounts',
  alertPhones: 'adminListUnionAlertPhones',
  riskRules: 'adminListRiskRules',
  search: 'adminSearch',
  level: 'adminChangeUserLevel',
  inviter: 'adminChangeInviter',
  invitees: 'adminListInvitees',
  profile: 'adminEditUserProfile',
  approve: 'adminApproveClaimItem',
  reject: 'adminRejectClaimItem',
} as const;
const EVERY: readonly string[] = Object.values(OPS);

/** A planned list made of exactly these operationIds. */
export function planned(...ids: string[]): ReadonlySet<string> {
  return new Set(ids);
}
/** Every operationId above except these: those routes have shipped (their mark was removed). */
export function shipped(...ids: string[]): ReadonlySet<string> {
  return new Set(EVERY.filter((id) => !ids.includes(id)));
}
export const ALL_PLANNED: ReadonlySet<string> = shipped();

export interface Hit {
  readonly method: string;
  readonly path: string;
}

/** Records each request (method + path), then answers it from `inner` (else a 20001 envelope). */
export function recorder(inner?: typeof globalThis.fetch) {
  const log: Hit[] = [];
  let pending = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    log.push({ method, path: url.pathname });
    pending += 1;
    try {
      if (inner === undefined) return failure(20001, { fields: ['path'] });
      return await inner(input, init);
    } finally {
      pending -= 1;
    }
  };
  return {
    log,
    fetch,
    get pending() {
      return pending;
    },
    hits(method: string, path: string | RegExp): Hit[] {
      return log.filter(
        (hit) =>
          hit.method === method &&
          (typeof path === 'string' ? hit.path === path : path.test(hit.path)),
      );
    },
  };
}
export type Recorder = ReturnType<typeof recorder>;

/** Sends each path to the first matching fake server; unknown paths get a 20001 envelope. */
export function routes(
  table: ReadonlyArray<readonly [RegExp, typeof globalThis.fetch]>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const found = table.find(([pattern]) => pattern.test(path));
    return found === undefined ? failure(20001, { fields: ['path'] }) : found[1](input, init);
  };
}

export interface MountOptions {
  readonly route: string;
  readonly fetch: typeof globalThis.fetch;
  /** Not given: the option is left out entirely (what the frozen page tests do). */
  readonly planned?: ReadonlySet<string>;
  readonly snapshot?: PermissionSnapshot;
  readonly renderPage?: AdminAppOptions['renderPage'];
}

const sessions: AdminAuthProvider[] = [];

/** Unmounts the shell and signs out, so a test can mount again (e.g. after a route ships). */
export function reset(): void {
  cleanup();
  for (const session of sessions.splice(0)) session.dispose();
  window.history.replaceState(null, '', '/');
}

afterEach(() => {
  reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

export async function mount(options: MountOptions) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const auth = harness().create();
  sessions.push(auth);
  await signIn(auth);
  window.history.replaceState(null, '', options.route);
  const onError = vi.fn();
  const snapshot = options.snapshot ?? SUPER;
  await act(async () => {
    render(
      createAdminShell({
        router: 'browser',
        authProvider: auth,
        permissionsProvider: async () => snapshot,
        account: { username: 'ops-yi', displayName: '运营' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: options.fetch,
          getToken: () => 'example-admin-token',
          onError,
        }),
        ...(options.planned === undefined ? {} : { plannedOperations: options.planned }),
        ...(options.renderPage === undefined ? {} : { renderPage: options.renderPage }),
      }),
    );
  });
  return { directFetch, onError };
}

export function mainElement(): HTMLElement {
  const main = document.querySelector<HTMLElement>('main');
  expect(main, 'the shell renders its main landmark').not.toBeNull();
  return main!;
}

export function menuLink(name: string): HTMLElement {
  const nav = screen.queryByRole('navigation', { name: '主导航' });
  expect(nav, 'sidebar 主导航').not.toBeNull();
  const links = within(nav!).queryAllByRole('link', { name });
  expect(links, `menu link ${name}`).toHaveLength(1);
  return links[0]!;
}

export function tab(name: string): HTMLElement {
  const tabs = screen.queryAllByRole('tab', { name });
  expect(tabs, `tab ${name}`).toHaveLength(1);
  return tabs[0]!;
}

export async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(node);
  });
}

/** The content area shows the 「功能开发中」 placeholder. */
export async function placeholder(): Promise<void> {
  await waitFor(() => expect(mainElement().textContent).toContain(PLANNED));
}

/** No request in flight and React has flushed what followed the last one. */
export async function settled(server: { readonly pending: number }): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  for (let round = 0; round < 5; round += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

/** No error toast and nothing reported to the data provider's onError. */
export function noToast(onError: Mock): void {
  expect(onError).not.toHaveBeenCalled();
  expect(document.querySelectorAll('.ant-message-notice, .ant-notification-notice')).toHaveLength(
    0,
  );
}

/** 「不弹错误」 on a placeholder page: no toast, no failure state, no retry. */
export function quiet(onError: Mock): void {
  noToast(onError);
  expect(mainElement().textContent).not.toMatch(/失败|出错|错误/);
  expect(within(mainElement()).queryAllByRole('button', { name: /重试/ })).toHaveLength(0);
}

export function buttons(scope: HTMLElement, name: RegExp): HTMLElement[] {
  return within(scope).queryAllByRole('button', { name });
}

export function isDisabled(node: HTMLElement): boolean {
  return node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true';
}

/** The mark sits on the control itself, its description, or right beside it. */
function markedNearby(node: HTMLElement): boolean {
  const texts: (string | null)[] = [
    node.textContent,
    node.getAttribute('aria-label'),
    node.getAttribute('title'),
    node.getAttribute('aria-description'),
  ];
  for (const id of (node.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean))
    texts.push(document.getElementById(id)?.textContent ?? null);
  let parent = node.parentElement;
  for (let depth = 0; depth < 3 && parent !== null && parent.tagName !== 'MAIN'; depth += 1) {
    texts.push(parent.getAttribute('title'), parent.getAttribute('aria-label'), parent.textContent);
    parent = parent.parentElement;
  }
  return texts.some((text) => text?.includes(PLANNED) ?? false);
}

/** Static mark, or a tooltip that names it on hover / focus. */
export async function marked(node: HTMLElement): Promise<boolean> {
  if (markedNearby(node)) return true;
  const targets = [node, node.parentElement].filter(
    (target): target is HTMLElement => target !== null,
  );
  await act(async () => {
    for (const target of targets) {
      fireEvent.pointerEnter(target);
      fireEvent.mouseEnter(target);
      fireEvent.mouseOver(target);
      fireEvent.focus(target);
    }
  });
  const shown = await waitFor(
    () =>
      expect(
        screen.queryAllByRole('tooltip').some((tip) => tip.textContent?.includes(PLANNED)),
      ).toBe(true),
    { timeout: 2000 },
  ).then(
    () => true,
    () => false,
  );
  await act(async () => {
    for (const target of targets) {
      fireEvent.pointerLeave(target);
      fireEvent.mouseLeave(target);
      fireEvent.blur(target);
    }
  });
  return shown;
}

/** 置灰并标「功能开发中」. */
export async function expectPlannedButton(node: HTMLElement, label: string): Promise<void> {
  expect(isDisabled(node), `【${label}】置灰`).toBe(true);
  expect(await marked(node), `【${label}】标「功能开发中」`).toBe(true);
}

/** The top-bar search box (the one textbox of the banner). */
export async function searchBox(): Promise<HTMLInputElement> {
  await waitFor(() => {
    const banner = screen.queryByRole('banner');
    expect(banner, 'top bar').not.toBeNull();
    expect(within(banner!).queryAllByRole('textbox'), 'top-bar search box').toHaveLength(1);
  });
  return within(screen.queryByRole('banner')!).queryAllByRole('textbox')[0] as HTMLInputElement;
}

/** Opens the box, types a full order number, presses Enter, then clicks the magnifier if any. */
export async function attemptSearch(box: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.mouseDown(box);
    fireEvent.focus(box);
    fireEvent.click(box);
    fireEvent.change(box, { target: { value } });
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 13 });
  });
  const magnifier =
    screen.queryByRole('banner')?.querySelector<HTMLElement>('.ant-input-search-button') ?? null;
  if (magnifier !== null) await click(magnifier);
}

/** 「功能开发中」 on the box (placeholder, title, description) or shown once it was opened. */
export function searchMarked(box: HTMLElement): boolean {
  if (document.body.textContent?.includes(PLANNED)) return true;
  const texts: (string | null)[] = [
    box.getAttribute('placeholder'),
    box.getAttribute('title'),
    box.getAttribute('aria-label'),
    box.getAttribute('aria-description'),
  ];
  for (const id of (box.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean))
    texts.push(document.getElementById(id)?.textContent ?? null);
  let parent = box.parentElement;
  for (let depth = 0; depth < 4 && parent !== null; depth += 1) {
    texts.push(parent.getAttribute('title'), parent.getAttribute('aria-label'));
    parent = parent.parentElement;
  }
  return texts.some((text) => text?.includes(PLANNED) ?? false);
}

/** Nothing opened: no dialog, no drawer, no step-up modal. */
export function noDialog(): void {
  expect(screen.queryAllByRole('dialog')).toHaveLength(0);
}
