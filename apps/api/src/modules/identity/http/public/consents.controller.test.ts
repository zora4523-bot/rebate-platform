// The consent handler's clipboard_auto_import rule (B1-02zc): the verified device published by the
// consent signature check is required for that type (fail closed 10401) and becomes its subject;
// other types never carry it.
import { expect, it, vi } from 'vitest';
import type { ConsentService } from '../../application/consents.ts';
import { ConsentsController } from './consents.controller.ts';

const DEVICE = { deviceId: '019a0000-0000-7000-8000-000000000002', appId: 'couli' };
const PRINCIPAL = {
  uid: '019a0000-0000-7000-8000-000000000010',
  app_id: 'couli',
  sid: 'session-unit',
  device_id: '019a0000-0000-7000-8000-000000000001',
  scp: 'full',
} as const;
const CLIPBOARD = {
  type: 'clipboard_auto_import',
  version: '2026-10-17',
  accepted: true,
  channel: 'privacy_center',
  client_at: '2026-10-08T01:59:00.000Z',
} as const;
const HEADERS = { 'x-app-id': 'couli', 'x-device-id': PRINCIPAL.device_id };

it('[BR-ID-12][BR-ID-09] clipboard_auto_import without a verified device is 10401 and never reaches the service', async () => {
  const record = vi.fn<ConsentService['record']>(async () => ({ code: 0, data: {} }));
  const controller = new ConsentsController({ record });
  await expect(
    controller.record({ id: 'trace', headers: HEADERS, body: CLIPBOARD, principal: PRINCIPAL }),
  ).rejects.toMatchObject({ code: 10401, statusCode: 401 });
  expect(record).not.toHaveBeenCalled();
});

it('[BR-ID-12] clipboard_auto_import hands the signed device to the service even when the token names another device', async () => {
  const record = vi.fn<ConsentService['record']>(async () => ({ code: 0, data: {} }));
  const controller = new ConsentsController({ record });
  await controller.record({
    id: 'trace',
    headers: HEADERS,
    body: CLIPBOARD,
    principal: PRINCIPAL,
    verifiedDevice: DEVICE,
  });
  expect(record).toHaveBeenLastCalledWith(
    expect.objectContaining({ principal: PRINCIPAL, verified_device: DEVICE }),
  );
  record.mockResolvedValueOnce({ code: 10402 });
  await expect(
    controller.record({ id: 'trace', headers: HEADERS, body: CLIPBOARD, verifiedDevice: DEVICE }),
  ).rejects.toMatchObject({ code: 10402, statusCode: 401 });
  record.mockResolvedValueOnce({ code: 10403 });
  await expect(
    controller.record({ id: 'trace', headers: HEADERS, body: CLIPBOARD, verifiedDevice: DEVICE }),
  ).rejects.toMatchObject({ status: 403 });
  const privacy = { ...CLIPBOARD, type: 'privacy', version: 3 } as const;
  await controller.record({ id: 'trace', headers: HEADERS, body: privacy, verifiedDevice: DEVICE });
  expect(record.mock.lastCall?.[0]).not.toHaveProperty('verified_device');
});
