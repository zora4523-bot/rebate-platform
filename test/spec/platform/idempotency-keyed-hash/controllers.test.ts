// 与 identity 的 HTTP kit 一样动态导入 Nest 源码，避免 test 项目编译装饰器。
// 此处按任务 C.5 使用替身幂等服务记录真实控制器调用，不执行身份用例。
import { expect, it, vi } from 'vitest';
import type { Idempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { BODY, SAVED, TRACE } from './kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const PRINCIPAL = {
  uid: '0199a3b4-5c6d-7e8f-9a0b-000000000001',
  app_id: 'couli',
  sid: '0199a3b4-5c6d-7e8f-9a0b-000000000002',
  device_id: '0199a3b4-5c6d-7e8f-9a0b-000000000003',
  scp: 'full',
};

function recordingIdempotency() {
  const response = { ...SAVED, source: 'replay' as const };
  const execute = vi.fn<Idempotency['execute']>(async () => response);
  const executeInTransaction = vi.fn<Idempotency['executeInTransaction']>(async () => response);
  const idem: Idempotency = {
    execute,
    executeInTransaction,
    abandon: vi.fn(async () => response),
    purgeExpired: vi.fn(async () => 0),
  };
  const reply = {
    code: vi.fn(() => reply),
    type: vi.fn(() => reply),
    send: vi.fn(),
  };
  return { idem, execute, executeInTransaction, reply };
}

it('[AC-B1-01zzf#8] submitRealname 显式开启 keyedRequestDigest 并传入完整实名请求体', async () => {
  const { RealnameController } = (await import(
    new URL('apps/api/src/modules/identity/http/public/realname.controller.ts', ROOT).href
  )) as {
    RealnameController: new (
      service: object,
      idem: Idempotency,
    ) => {
      submit(request: object, reply: object): Promise<void>;
    };
  };
  const f = recordingIdempotency();
  const submit = vi.fn();
  const body = { name: BODY.name, id_no: BODY.id_no };
  await new RealnameController({ submit }, f.idem).submit(
    {
      id: TRACE,
      principal: PRINCIPAL,
      headers: { 'idempotency-key': 'realname-request' },
      body,
    },
    f.reply,
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      keyedRequestDigest: true,
      appId: PRINCIPAL.app_id,
      actor: { userId: PRINCIPAL.uid, deviceId: PRINCIPAL.device_id, phoneHmac: null },
      method: 'POST',
      path: '/v1/me/realname',
      key: 'realname-request',
      body,
      traceId: TRACE,
    }),
    expect.any(Function),
  );
  expect(f.executeInTransaction).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(f.reply.send).toHaveBeenCalledWith(SAVED.body);
});

it('[AC-B1-01zzf#9] bindPhone 显式开启 keyedRequestDigest 并保留事务执行模式', async () => {
  const { BindPhoneController } = (await import(
    new URL('apps/api/src/modules/identity/http/public/bind-phone.controller.ts', ROOT).href
  )) as {
    BindPhoneController: new (
      service: object,
      idem: Idempotency,
    ) => {
      bind(request: object, reply: object): Promise<void>;
    };
  };
  const f = recordingIdempotency();
  const bind = vi.fn();
  const body = { phone: BODY.phone, code: '123456' };
  await new BindPhoneController({ bind }, f.idem).bind(
    {
      id: TRACE,
      principal: PRINCIPAL,
      verifiedDevice: { deviceId: PRINCIPAL.device_id },
      headers: { 'idempotency-key': 'bind-phone-request' },
      body,
    },
    f.reply,
  );
  expect(f.executeInTransaction).toHaveBeenCalledTimes(1);
  expect(f.executeInTransaction).toHaveBeenCalledWith(
    expect.objectContaining({
      keyedRequestDigest: true,
      appId: PRINCIPAL.app_id,
      actor: { userId: PRINCIPAL.uid, deviceId: PRINCIPAL.device_id, phoneHmac: null },
      method: 'POST',
      path: '/v1/me/phone',
      key: 'bind-phone-request',
      body,
      traceId: TRACE,
    }),
    expect.any(Function),
  );
  expect(f.execute).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
  expect(f.reply.send).toHaveBeenCalledWith(SAVED.body);
});
