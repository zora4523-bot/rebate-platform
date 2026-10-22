import { describe, expect, it, vi } from 'vitest';
import { createWithdrawSwitchCheck, isWithdrawalApplication } from './withdraw-switch-check.ts';

describe('withdraw switch post-miss check (BR-WDR-03 ①)', () => {
  it('matches only the withdrawal application', () => {
    expect(isWithdrawalApplication({ method: 'POST', path: '/v1/withdrawals' })).toBe(true);
    expect(isWithdrawalApplication({ method: 'PUT', path: '/v1/withdrawals' })).toBe(false);
    expect(isWithdrawalApplication({ method: 'POST', path: '/v1/me/deletion' })).toBe(false);
  });

  it('is a no-op for other operations and never reads the configuration for them', async () => {
    const configValue = vi.fn();
    const check = createWithdrawSwitchCheck({ config: { configValue }, logger: { warn: vi.fn() } });
    await expect(
      check({
        appId: 'a',
        actor: { userId: 'u', deviceId: null, phoneHmac: null },
        method: 'POST',
        path: '/v1/me/deletion',
        key: 'k',
        body: {},
        traceId: 't',
      }),
    ).resolves.toBeUndefined();
    expect(configValue).not.toHaveBeenCalled();
  });

  it('fails closed outside a claim (no transaction to read on)', async () => {
    const check = createWithdrawSwitchCheck({
      config: { configValue: vi.fn() },
      logger: { warn: vi.fn() },
    });
    await expect(
      check({
        appId: 'a',
        actor: { userId: 'u', deviceId: null, phoneHmac: null },
        method: 'POST',
        path: '/v1/withdrawals',
        key: 'k',
        body: { amount_fen: 100 },
        traceId: 't',
      }),
    ).rejects.toThrow(/claim/);
  });
});
