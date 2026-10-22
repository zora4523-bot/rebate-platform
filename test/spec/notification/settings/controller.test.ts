// Fake application ports: no database and no HTTP listener.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { NotificationSettingsService } from '../../../../apps/api/src/modules/notification/application/notification-settings.ts';
import { NotificationSettingsController } from '../../../../apps/api/src/modules/notification/http/public/notification-settings.controller.ts';
import type { TokenPrincipal } from '../../../../apps/api/src/modules/platform/http/token-context.ts';
import { expectSchema, OFF, ON } from './kit.ts';

function fixture() {
  const principal: TokenPrincipal = {
    app_id: 'settings_app',
    uid: randomUUID(),
    sid: 'settings-session',
    device_id: randomUUID(),
    scp: 'full',
  };
  const get = vi.fn<NotificationSettingsService['get']>().mockResolvedValue(OFF);
  const update = vi.fn<NotificationSettingsService['update']>().mockResolvedValue(OFF);
  return {
    get,
    update,
    principal,
    request: {
      id: randomBytes(16).toString('hex'),
      principal,
      headers: { 'x-app-id': 'untrusted_app', 'x-user-id': randomUUID() },
    },
  };
}

it('[AC-B1-12m#1] GET只按登录主体读取，并返回用例结果及trace_id', async () => {
  const f = fixture();
  const controller = new NotificationSettingsController(f);
  const response = await controller.get(f.request);
  expect(f.get).toHaveBeenCalledExactlyOnceWith({
    app_id: f.principal.app_id,
    user_id: f.principal.uid,
  });
  expect(f.update).not.toHaveBeenCalled();
  expect(response).toEqual({ code: 0, msg: '', data: OFF, trace_id: f.request.id });
  await expectSchema('getNotificationSettings', '200', response);
});

it('[AC-B1-12m#2] PUT只按登录主体整体传递三个开关，响应取保存结果而非原请求', async () => {
  const f = fixture();
  const controller = new NotificationSettingsController(f);
  const response = await controller.update(f.request, ON);
  expect(f.update).toHaveBeenCalledExactlyOnceWith(
    { app_id: f.principal.app_id, user_id: f.principal.uid },
    ON,
  );
  expect(f.get).not.toHaveBeenCalled();
  expect(response).toEqual({ code: 0, msg: '', data: OFF, trace_id: f.request.id });
  await expectSchema('updateNotificationSettings', '200', response);
});

it.each(['get', 'update'] as const)(
  '[AC-B1-12m#3] %s没有登录主体时拒绝且不调用读写口',
  async (method) => {
    const f = fixture();
    const controller = new NotificationSettingsController(f);
    const request = { id: f.request.id, headers: f.request.headers };
    const result = method === 'get' ? controller.get(request) : controller.update(request, ON);
    const error: unknown = await result.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    const http = error as { getStatus?: () => number; getResponse?: () => unknown };
    expect(typeof http.getStatus).toBe('function');
    expect(typeof http.getResponse).toBe('function');
    expect(http.getStatus!()).toBe(401);
    expect(http.getResponse!()).toMatchObject({ code: 10001, trace_id: request.id });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  },
);
