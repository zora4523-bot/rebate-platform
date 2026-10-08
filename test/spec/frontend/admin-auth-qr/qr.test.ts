// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  AdminAuthProvider,
  AdminBindingSecret,
} from '../../../../apps/admin/src/providers/auth/index.ts';
import { getLoginTexts } from '../../../../apps/admin/src/texts/login.ts';
import { SECRET, harness, ok, rejected } from '../admin-auth/fixtures.ts';
import {
  URI_VARIANT,
  click,
  code,
  credentials,
  disabled,
  installMediaQuery,
  mountLogin,
  qrDrawing,
} from './helpers.ts';

const providers: AdminAuthProvider[] = [];
beforeEach(installMediaQuery);
afterEach(() => {
  cleanup();
  for (const auth of providers.splice(0)) auth.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('[AC-F1-06j-QR#1] 加载和失败时不画码，重新获取成功才展示可访问 SVG 真码，卸载丢弃密钥', async () => {
  const pending = Promise.withResolvers<Response>();
  const h0 = harness('bind_totp');
  h0.queue('/admin/v1/auth/totp/secret', () => pending.promise);
  const h = mountLogin(providers, h0);
  await credentials();
  await waitFor(() => expect(screen.queryByText('正在生成密钥…')).not.toBeNull());
  expect(qrDrawing()).toBe('');
  await code();
  expect(disabled(screen.getByRole('button', { name: '验证并绑定' }))).toBe(true);
  await act(async () => {
    pending.resolve(rejected(50001));
  });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: '重新获取密钥' })).not.toBeNull(),
  );
  expect(qrDrawing()).toBe('');
  expect(disabled(screen.getByRole('button', { name: '验证并绑定' }))).toBe(true);
  await click('重新获取密钥');
  await waitFor(() => expect(h.auth.getSnapshot().secret).toEqual(SECRET));
  const region = screen.queryByRole('img', { name: /二维码/ });
  expect(region).not.toBeNull();
  expect(region?.querySelector('svg')).not.toBeNull();
  expect(qrDrawing()).not.toBe('');
  expect(region?.querySelector('canvas')).toBeNull();
  expect(region?.getAttribute('aria-label')).not.toContain('占位');
  expect(screen.queryByText(/此处为占位/)).toBeNull();
  expect(disabled(screen.getByRole('button', { name: '验证并绑定' }))).toBe(false);
  expect(h.storage.setItem).not.toHaveBeenCalled();
  expect(window.location.href).not.toContain('otpauth');
  expect(window.location.href).not.toContain(SECRET.totp_secret);
  h.view.unmount();
  expect(h.auth.getSnapshot().secret).toBeUndefined();
  expect(screen.queryByRole('img', { name: /二维码/ })).toBeNull();
});

it('[AC-F1-06j-QR#2] 同 URI 的码图稳定；密钥相同但 URI 不同也必须改变码图', async () => {
  async function drawing(secret: AdminBindingSecret) {
    const h0 = harness('bind_totp');
    h0.queue('/admin/v1/auth/totp/secret', () => ok(secret));
    const h = mountLogin(providers, h0);
    await credentials();
    await waitFor(() => expect(h.auth.getSnapshot().secret).toEqual(secret));
    const region = screen.queryByRole('img', { name: /二维码/ });
    expect(region?.querySelector('svg') ?? null).not.toBeNull();
    const shape = qrDrawing();
    expect(shape).not.toBe('');
    h.view.unmount();
    return shape;
  }
  const first = await drawing(SECRET);
  expect(await drawing(SECRET)).toBe(first);
  expect(await drawing(URI_VARIANT)).not.toBe(first);
});

it('[AC-F1-06j-QR#3] 删除三行占位文案键，二维码可访问说明不再宣称占位', () => {
  const texts = getLoginTexts();
  for (const key of ['bind.qr_line1', 'bind.qr_line2', 'bind.qr_line3'])
    expect(Object.hasOwn(texts, key), key).toBe(false);
  expect(texts['bind.qr_label']).toContain('二维码');
  expect(texts['bind.qr_label']).not.toContain('占位');
});
