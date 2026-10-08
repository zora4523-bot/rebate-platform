// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { SECRET, TITLES, harness, ok, rejected, stepData } from '../admin-auth/fixtures.ts';
import {
  SECOND_SECRET,
  click,
  code,
  credentials,
  disabled,
  installMediaQuery,
  mountLogin,
  secretRequestCount,
} from './helpers.ts';

const providers: AdminAuthProvider[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  installMediaQuery();
});
afterEach(() => {
  cleanup();
  for (const auth of providers.splice(0)) auth.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

for (const action of ['换账号', '返回上一步']) {
  for (const outcome of ['success', 'expired'] as const) {
    it(`[AC-F1-06j-SECRET#1] ${action}后立即可重新登录，旧密钥${outcome}晚于新账号密钥到达也不能覆盖新状态`, async () => {
      const old = Promise.withResolvers<Response>();
      const oldStarted = Promise.withResolvers<void>();
      const fresh = Promise.withResolvers<Response>();
      const freshStarted = Promise.withResolvers<void>();
      const h0 = harness('bind_totp');
      h0.queue('/admin/v1/auth/totp/secret', () => {
        oldStarted.resolve();
        return old.promise;
      });
      h0.queue('/admin/v1/auth/totp/secret', () => {
        freshStarted.resolve();
        return fresh.promise;
      });
      const h = mountLogin(providers, h0);
      await credentials();
      await oldStarted.promise;
      expect(h.auth.getSnapshot().secretLoading).toBe(true);
      await click(action);
      expect(screen.queryByRole('heading', { name: TITLES.credentials })).not.toBeNull();
      // Existing F1-06h keeps this disabled until the abandoned account's request settles.
      expect(disabled(screen.getByRole('button', { name: '下一步' }))).toBe(false);
      h.queue('/admin/v1/auth/login', () =>
        ok({ ...stepData('bind_totp'), login_ticket: 'example-second-account-ticket' }),
      );
      await credentials('ops-er');
      await freshStarted.promise;
      expect(secretRequestCount(h)).toBe(2);
      await act(async () => {
        fresh.resolve(ok(SECOND_SECRET));
      });
      expect(h.auth.getSnapshot()).toMatchObject({
        username: 'ops-er',
        step: 'bind_totp',
        secret: SECOND_SECRET,
      });
      await code();
      expect(disabled(screen.getByRole('button', { name: '验证并绑定' }))).toBe(false);
      await act(async () => {
        old.resolve(
          outcome === 'success' ? ok(SECRET) : rejected(10001, { reason: 'login_ticket_expired' }),
        );
      });
      expect(h.auth.getSnapshot()).toMatchObject({
        username: 'ops-er',
        step: 'bind_totp',
        secret: SECOND_SECRET,
      });
      expect(h.auth.getSnapshot().error).toBeUndefined();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText('JBSW Y3DP EHPK 3PXP')).toBeNull();
      expect(disabled(screen.getByRole('button', { name: '验证并绑定' }))).toBe(false);
      await click('验证并绑定');
      expect(h.requests.find((request) => request.path.endsWith('/totp/bind'))?.body).toEqual({
        login_ticket: 'example-second-account-ticket',
        code: '123456',
      });
      expect(h.auth.getSnapshot().step).toBe('done');
    });
  }
}

for (const attempt of ['首次获取', '失败后重新获取']) {
  it(`[AC-F1-06j-SECRET#2] ${attempt}在 10 秒内超时，允许重试且丢弃超时请求的迟到回包`, async () => {
    const late = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const replacement = Promise.withResolvers<Response>();
    const replacementStarted = Promise.withResolvers<void>();
    const h0 = harness('bind_totp');
    if (attempt === '失败后重新获取') h0.queue('/admin/v1/auth/totp/secret', () => rejected(50001));
    h0.queue('/admin/v1/auth/totp/secret', () => {
      started.resolve();
      return late.promise;
    });
    h0.queue('/admin/v1/auth/totp/secret', () => {
      replacementStarted.resolve();
      return replacement.promise;
    });
    const h = mountLogin(providers, h0);
    await credentials();
    if (attempt === '失败后重新获取') await click('重新获取密钥');
    await started.promise;
    expect(h.auth.getSnapshot().secretLoading).toBe(true);
    await code();
    expect(disabled(screen.getByRole('button', { name: '验证并绑定' }))).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const button = screen.queryByRole('button', { name: '重新获取密钥' });
    // Query + assertion, not a missing-element exception or a real-time timeout, is the red.
    expect(button).not.toBeNull();
    expect(disabled(button!)).toBe(false);
    expect(h.auth.getSnapshot().secret).toBeUndefined();
    expect(h.auth.getSnapshot().secretLoading).not.toBe(true);
    expect(disabled(screen.getByRole('button', { name: '验证并绑定' }))).toBe(true);
    await click('重新获取密钥');
    await replacementStarted.promise;
    await act(async () => {
      late.resolve(ok(SECRET));
    });
    expect(h.auth.getSnapshot().secret).toBeUndefined();
    expect(h.auth.getSnapshot().secretLoading).toBe(true);
    expect(disabled(screen.getByRole('button', { name: '验证并绑定' }))).toBe(true);
    await act(async () => {
      replacement.resolve(ok(SECOND_SECRET));
    });
    expect(h.auth.getSnapshot().secret).toEqual(SECOND_SECRET);
    expect(h.auth.getSnapshot().error).toBeUndefined();
    expect(screen.queryByRole('button', { name: '重新获取密钥' })).toBeNull();
    expect(disabled(screen.getByRole('button', { name: '验证并绑定' }))).toBe(false);
    expect(secretRequestCount(h)).toBe(attempt === '首次获取' ? 2 : 3);
  });
}
