import { act, createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { LoginPage } from '../../../../apps/admin/src/pages/login/index.ts';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { permissionsFromMe } from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { CREDENTIALS, SECRET, harness } from '../admin-auth/fixtures.ts';

// Synthetic second account: the transport remains the existing contract-example harness.
export const SECOND_SECRET = {
  totp_secret: 'KRSXG5DSNFXGOIDB',
  otpauth_uri:
    'otpauth://totp/Couli%20Admin:ops-er?secret=KRSXG5DSNFXGOIDB&issuer=Couli%20Admin&digits=6&period=30',
};

export function installMediaQuery() {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
}

export function mountLogin(providers: AdminAuthProvider[], h = harness('bind_totp')) {
  // The read-only F1-06h harness controls replies but does not model fetch cancellation.
  // Preserve that transport while accepting either epoch invalidation or AbortController.
  const transport = h.options.api.fetch;
  h.options.api.fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const signal = init?.signal;
    if (signal == null) return transport(input, init);
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(new DOMException('Request cancelled', 'AbortError'));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      void transport(input, init).then(
        (response) => {
          signal.removeEventListener('abort', abort);
          resolve(response);
        },
        (cause: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(cause);
        },
      );
    });
  });
  const auth = h.create();
  providers.push(auth);
  const onComplete = vi.fn();
  const view = render(
    createElement(LoginPage, { authProvider: auth, environment: 'test', onComplete }),
  );
  return { ...h, auth, view, onComplete };
}

export function mountShell(
  providers: AdminAuthProvider[],
  h = harness(),
  logout?: (auth: AdminAuthProvider) => Promise<void>,
) {
  const auth = h.create();
  providers.push(auth);
  window.history.replaceState(null, '', '/login');
  const onLogout = vi.fn(async () => {
    if (logout !== undefined) await logout(auth);
    else await auth.logout();
  });
  const view = render(
    createAdminShell({
      authProvider: auth,
      environment: 'test',
      router: 'browser',
      account: { username: CREDENTIALS.username, displayName: CREDENTIALS.username },
      permissionsProvider: async () => {
        const me = await auth.getIdentity({ refresh: true });
        if (me === null) throw new Error('No test session');
        return permissionsFromMe(me);
      },
      onLogout,
      renderPage: (id) => createElement('div', null, `page:${id}`),
    }),
  );
  return { ...h, auth, onLogout, view };
}

// No user-event delays or polling under the fake clock. Each act drains React's updates;
// request-start promises in the timing tests establish the precise transport boundary.
export async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

export async function credentials(username: string = CREDENTIALS.username) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/^账号/), { target: { value: username } });
    fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: CREDENTIALS.password } });
  });
  await click('下一步');
}

export async function code(value = '123456') {
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox', { name: '动态码' }), { target: { value } });
  });
}

export function disabled(button: HTMLElement): boolean {
  return (button as HTMLButtonElement).disabled || button.getAttribute('aria-disabled') === 'true';
}

export function qrDrawing(): string {
  const region = screen.queryByRole('img', { name: /二维码/ });
  return [...(region?.querySelectorAll('svg path, svg rect') ?? [])]
    .map((element) =>
      ['d', 'x', 'y', 'width', 'height'].map((name) => element.getAttribute(name)).join(':'),
    )
    .join('|');
}

export function secretRequestCount(h: ReturnType<typeof harness>): number {
  return h.requests.filter((request) => request.path === '/admin/v1/auth/totp/secret').length;
}

export const URI_VARIANT = {
  ...SECRET,
  // Same manual secret, different URI label: encoding only totp_secret must fail.
  otpauth_uri: SECRET.otpauth_uri.replace('ops-yi?', 'ops-er?'),
};
