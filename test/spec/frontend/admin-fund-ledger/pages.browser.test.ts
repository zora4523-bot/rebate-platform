/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { BASE_URL, createServer, platformPattern, snapshot } from './fixtures.ts';

// The real /fund-ledger route of the admin app in Chromium: the daily ledger (asset snapshot
// view) lists the written snapshot days with their amounts as the snapshot wrote them (hand-
// computed from fen), the negative receivable with its minus sign; only GET
// /admin/v1/asset-snapshots goes out. Waits use expect.element only.
const FIRST = { timeout: 10_000 };
let root: Root | undefined;
let auth: AdminAuthProvider | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  auth?.dispose();
  auth = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

async function show(server = createServer()) {
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', '/fund-ledger');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => snapshot(server.permissions),
      account: { username: 'fin-ledger', displayName: '财务' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch: server.fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return server;
}

it('[AC-F1-08ga-BROWSER#1] /fund-ledger：按日台账列出快照日，2026-10-29 行显示可用余额合计 12,500.34、淘宝未回款 8,640.12 与拼多多 -23.00，2026-10-26 行显示 11,004.50；只发 GET /admin/v1/asset-snapshots', async () => {
  await page.viewport(1440, 1080);
  const server = await show();
  const rows = page.getByRole('main').getByRole('row');

  // 1250034 fen
  const latest = rows.filter({ hasText: /(?<![\d.])12,?500\.34(?!\d)/ });
  await expect.element(latest, FIRST).toBeVisible();
  await expect.element(latest).toMatchTextContent(/(?<![\d-])2026-10-29(?![\d-])/);
  // taobao 864012 fen, pdd −2300 fen (the minus sign stays)
  await expect.element(latest).toMatchTextContent(/(?<![\d.])8,?640\.12(?!\d)/);
  await expect.element(latest).toMatchTextContent(/[-−]\s*¥?\s*23\.00(?!\d)/);
  await expect.element(latest).toMatchTextContent(platformPattern('taobao'));
  await expect.element(latest).toMatchTextContent(platformPattern('pdd'));

  // 1100450 fen
  const older = rows.filter({ hasText: /(?<![\d.])11,?004\.50(?!\d)/ });
  await expect.element(older).toBeVisible();
  await expect.element(older).toMatchTextContent(/(?<![\d-])2026-10-26(?![\d-])/);

  expect(server.reads().length).toBeGreaterThan(0);
  expect(server.others()).toEqual([]);
});
