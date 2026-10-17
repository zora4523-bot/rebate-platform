// B1-12c · route handler with a substitute reporter (no database): the subject is the verified
// principal only; every rule outcome answers EmptyResponse (BR-ID-07 细则「上报时只接受当前会话」:
// 「接口仍返回成功」; contract reportPushToken).
import { expect, it, vi } from 'vitest';
import type { TokenPrincipal } from '../../../../apps/api/src/modules/platform/http/token-context.ts';
import type { PushTokenReporter } from '../../../../apps/api/src/modules/notification/application/push-token-report.ts';
import { PushTokenController } from '../../../../apps/api/src/modules/notification/http/public/push-token.controller.ts';

const TRACE = 'b112c000000000000000000000000001';
const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000210',
  app_id: 'couli',
  sid: 'session-b112c-unit',
  device_id: '019a0000-0000-7000-8000-000000000201',
  scp: 'full',
};

it('[AC-B1-12c#26][BR-ID-07] 处理函数只用令牌主体与请求体调用一次上报用例，回EmptyResponse', async () => {
  const report = vi.fn<PushTokenReporter['report']>().mockResolvedValue(undefined);
  const controller = new PushTokenController({ report });
  const response = await controller.report({
    id: TRACE,
    body: { provider: 'mobpush', token: 'pt-device-u-001' },
    headers: { 'x-app-id': 'other_app', 'x-device-id': '019a0000-0000-7000-8000-000000000299' },
    principal: PRINCIPAL,
  });
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith({
    app_id: 'couli',
    user_id: '019a0000-0000-7000-8000-000000000210',
    sid: 'session-b112c-unit',
    device_id: '019a0000-0000-7000-8000-000000000201',
    provider: 'mobpush',
    token: 'pt-device-u-001',
  });
  expect(response).toEqual({ code: 0, msg: '', data: {}, trace_id: TRACE });
});

it('[AC-B1-12c#27][BR-ID-07] 没有经令牌检查的主体时拒绝，且不调用上报用例', async () => {
  const report = vi.fn<PushTokenReporter['report']>().mockResolvedValue(undefined);
  const controller = new PushTokenController({ report });
  await expect(
    controller.report({ id: TRACE, body: { provider: 'mobpush', token: 'pt-device-u-002' } }),
  ).rejects.toThrow();
  expect(report).not.toHaveBeenCalled();
  // The same controller still serves a verified request afterwards.
  await expect(
    controller.report({
      id: TRACE,
      body: { provider: 'mobpush', token: 'pt-device-u-002' },
      principal: PRINCIPAL,
    }),
  ).resolves.toEqual({ code: 0, msg: '', data: {}, trace_id: TRACE });
});

it('[AC-B1-12c#28][BR-ID-07] 用例的基础设施失败原样上抛（交全局错误过滤器回50001），不吞成成功', async () => {
  const failure = new Error('fixture reporter failure');
  const report = vi.fn<PushTokenReporter['report']>().mockRejectedValue(failure);
  const controller = new PushTokenController({ report });
  await expect(
    controller.report({
      id: TRACE,
      body: { provider: 'mobpush', token: 'pt-device-u-003' },
      principal: PRINCIPAL,
    }),
  ).rejects.toBe(failure);
  expect(report).toHaveBeenCalledTimes(1);
});
