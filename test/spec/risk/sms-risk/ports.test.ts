import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createSmsRiskPorts } from '../../../../apps/api/src/modules/identity/application/sms-risk-ports.ts';
import type { SmsRisk } from '../../../../apps/api/src/modules/risk/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';

function fixture() {
  const { logger, lines } = memoryLogger();
  const risk = {
    admit: vi.fn<SmsRisk['admit']>(async () => ({ code: 0 })),
    recordAccepted: vi.fn<SmsRisk['recordAccepted']>(async () => undefined),
    recordRegistered: vi.fn<SmsRisk['recordRegistered']>(async () => undefined),
  };
  const deviceHash = 'ab'.repeat(32);
  const devices = { deviceHashOf: vi.fn(async (): Promise<string | null> => deviceHash) };
  const request = {
    app_id: 'sms_ports',
    device_id: randomUUID(),
    client_ip: '192.0.2.81',
    phone: '13812345678',
    purpose: 'login' as const,
    captcha_token: 'ignored',
  };
  return { logger, lines, risk, devices, deviceHash, request };
}

it('[AC-B1-03g#4][AC-B1-03g#8] identity 用 app_id/device_id 读哈希后调用风险端口，凭证不参与', async () => {
  const f = fixture();
  const ports = createSmsRiskPorts(f);
  expect(await ports.smsHooks.deviceQuota(f.request)).toBeNull();
  expect(f.devices.deviceHashOf).toHaveBeenCalledExactlyOnceWith(
    f.request.app_id,
    f.request.device_id,
  );
  expect(f.risk.admit).toHaveBeenCalledExactlyOnceWith({
    appId: f.request.app_id,
    deviceHash: f.deviceHash,
    phone: f.request.phone,
    clientIp: f.request.client_ip,
  });
  f.risk.admit.mockResolvedValue({ code: 42901, retryAfterSec: 17 });
  expect(await ports.smsHooks.deviceQuota(f.request)).toEqual({ code: 42901, retryAfterSec: 17 });
  await ports.smsHooks.afterAccepted(f.request);
  expect(f.risk.recordAccepted).toHaveBeenCalledExactlyOnceWith({
    appId: f.request.app_id,
    clientIp: f.request.client_ip,
  });
  expect(ports.smsHooks).not.toHaveProperty('captcha');
});

it.each(['missing', 'failed'] as const)(
  '[AC-B1-03g#9] device_hash 读取 %s 时 42901/1，不能退回按 device_id 放行',
  async (kind) => {
    const f = fixture();
    if (kind === 'missing') f.devices.deviceHashOf.mockResolvedValue(null);
    else
      f.devices.deviceHashOf.mockRejectedValue(
        new Error(`lookup failed for ${f.request.phone} at ${f.request.client_ip}`),
      );
    const ports = createSmsRiskPorts(f);
    expect(await ports.smsHooks.deviceQuota(f.request)).toEqual({ code: 42901, retryAfterSec: 1 });
    expect(f.risk.admit).not.toHaveBeenCalled();
    expect(f.lines.join('')).not.toContain(f.request.phone);
    expect(f.lines.join('')).not.toContain(f.request.client_ip);
  },
);
