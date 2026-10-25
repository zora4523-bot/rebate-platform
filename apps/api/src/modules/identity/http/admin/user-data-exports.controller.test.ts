// Unit tests of /admin/v1/users/{user_id}/data-exports' controller (B1-27c): the guard input, the
// identity taken from the guard, the answer's shape and the refusal envelopes (no database).
import { HttpException } from '@nestjs/common';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import type {
  AdminDataCopies,
  AdminDataCopyListInput,
  AdminDataCopyListResult,
  AdminDataCopyRegisterInput,
  AdminDataCopyRegisterResult,
  AdminDataCopyView,
} from '../../application/admin-data-copies.ts';
import type {
  AdminDataCopyDownload,
  AdminDataCopyDownloadInput,
  AdminDataCopyDownloadResult,
} from '../../application/admin-data-copy-download.ts';
import { AdminUserDataExportsController } from './user-data-exports.controller.ts';

const APP = 'b1_27c_ctrl';
const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const COPY = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d01';
const TRACE = 'trace-b1-27c';
const BODY = { reason: '企业微信核对注册时间与最近订单', app_login_ok: true, phone_sms_ok: true };

class FakeGuard extends AdminOperationGuard {
  readonly calls: AdminOperationInput[] = [];

  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.calls.push(input);
    return business({ adminId: ADMIN, appId: APP, isSuper: false, loginName: 'cs01' });
  }
}

const VIEW: AdminDataCopyView = {
  exportId: COPY,
  userId: USER,
  delivery: 'in_app_sms',
  status: 'pending',
  requestedBy: ADMIN,
  requestedByName: 'cs01',
  createdAt: new Date('2026-11-02T02:00:00.000Z'),
  dueAt: new Date('2026-11-23T16:00:00.000Z'),
  retryOf: null,
  generatedAt: null,
  deliveredAt: null,
  expiresAt: null,
  failureReason: null,
};

function setup(
  register: AdminDataCopyRegisterResult,
  list?: AdminDataCopyListResult,
  download?: AdminDataCopyDownloadResult,
) {
  const guard = new FakeGuard();
  const downloaded: AdminDataCopyDownloadInput[] = [];
  const downloads: AdminDataCopyDownload = {
    download: (input) => {
      downloaded.push(input);
      return Promise.resolve(download ?? { kind: 'unknown_export' });
    },
  };
  const registered: AdminDataCopyRegisterInput[] = [];
  const listed: AdminDataCopyListInput[] = [];
  const copies: AdminDataCopies = {
    register: (input) => {
      registered.push(input);
      return Promise.resolve(register);
    },
    list: (input) => {
      listed.push(input);
      return Promise.resolve(list ?? { kind: 'page', items: [], total: 0 });
    },
  };
  const controller = new AdminUserDataExportsController(guard, copies, downloads);
  const request = { id: TRACE, ip: '127.0.0.1', query: {} } as never;
  return { guard, registered, listed, downloaded, controller, request };
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  return { status: exception.getStatus(), body: exception.getResponse() };
}

it('[AC-B1-27c#11] 登记：守卫按 user.data_export 跑、身份取自守卫，回 reused 与 ISO 时间', async () => {
  const s = setup({ kind: 'registered', view: VIEW, reused: false });
  const answer = await s.controller.create(s.request, USER, BODY);
  expect(s.guard.calls).toEqual([{ request: s.request, permission: 'user.data_export' }]);
  expect(s.registered).toEqual([
    {
      appId: APP,
      adminId: ADMIN,
      userId: USER,
      reason: BODY.reason,
      appLoginOk: true,
      phoneSmsOk: true,
      ip: '127.0.0.1',
    },
  ]);
  expect(answer).toEqual({
    code: 0,
    msg: '',
    data: {
      export_id: COPY,
      user_id: USER,
      delivery: 'in_app_sms',
      status: 'pending',
      requested_by: ADMIN,
      requested_by_name: 'cs01',
      created_at: '2026-11-02T02:00:00.000Z',
      due_at: '2026-11-23T16:00:00.000Z',
      retry_of: null,
      generated_at: null,
      delivered_at: null,
      expires_at: null,
      failure_reason: null,
      reused: false,
    },
    trace_id: TRACE,
  });
});

it.each([
  { kind: 'unknown_user', status: 400, code: 20001, data: { fields: ['user_id'] } },
  { kind: 'phone_missing', status: 400, code: 20001, data: { fields: ['phone_sms_ok'] } },
  {
    kind: 'account_deleting',
    status: 422,
    code: 30419,
    data: { reason: 'account_deleting', stage: 'processing' },
  },
  { kind: 'account_deleted', status: 422, code: 30419, data: { reason: 'account_deleted' } },
  { kind: 'delivery_undecided', status: 422, code: 30419, data: { reason: 'delivery_undecided' } },
  {
    kind: 'permission_denied',
    status: 403,
    code: 10403,
    data: { reason: 'admin_permission_denied' },
  },
] as const)(
  '[AC-B1-27c#19] 登记被拒 $kind → $status / $code',
  async ({ kind, status, code, data }) => {
    const s = setup({ kind });
    const refused = await refusal(s.controller.create(s.request, USER, BODY));
    expect(refused.status).toBe(status);
    expect(refused.body).toMatchObject({ code, data, trace_id: TRACE });
  },
);

it('[AC-B1-27c#35] 列表：只读守卫，默认第 1 页每页 20 条；未知用户 → 20001 [user_id]', async () => {
  const s = setup({ kind: 'unknown_user' }, { kind: 'page', items: [VIEW], total: 1 });
  const page = await s.controller.list(s.request, USER);
  expect(s.guard.calls).toEqual([
    { request: s.request, permission: 'user.data_export', readOnly: true },
  ]);
  expect(s.listed).toEqual([{ appId: APP, userId: USER, page: 1, pageSize: 20 }]);
  expect(page.data).toMatchObject({ page: 1, page_size: 20, total: 1 });
  expect(page.data.items.map((item) => item.export_id)).toEqual([COPY]);
  expect(page.data.items[0]).not.toHaveProperty('reused');

  const missing = setup({ kind: 'unknown_user' }, { kind: 'unknown_user' });
  const refused = await refusal(missing.controller.list(missing.request, USER));
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({ code: 20001, data: { fields: ['user_id'] } });
});

function headers() {
  const set: Record<string, string> = {};
  return { set, reply: { header: (name: string, value: string) => (set[name] = value) } };
}

it('[B1-27i] 下载：守卫按 user.data_export 跑（totp），regenerate 缺省为 false，回链接、口令与 no-store', async () => {
  const s = setup({ kind: 'unknown_user' }, undefined, {
    kind: 'link',
    url: 'https://exports.invalid/k?expires=1&signature=0',
    urlExpiresAt: new Date('2026-11-03T02:25:00.000Z'),
    password: 'ABCD2345',
    expiresAt: new Date('2026-11-04T02:20:00.000Z'),
  });
  const h = headers();
  const answer = await s.controller.download(s.request, USER, COPY, {}, h.reply);
  expect(h.set).toEqual({ 'Cache-Control': 'no-store' });
  expect(s.guard.calls).toEqual([{ request: s.request, permission: 'user.data_export' }]);
  expect(s.downloaded).toEqual([
    {
      appId: APP,
      adminId: ADMIN,
      userId: USER,
      exportId: COPY,
      regenerate: false,
      ip: '127.0.0.1',
    },
  ]);
  expect(answer).toEqual({
    code: 0,
    msg: '',
    data: {
      url: 'https://exports.invalid/k?expires=1&signature=0',
      url_expires_at: '2026-11-03T02:25:00.000Z',
      password: 'ABCD2345',
      status: 'delivered',
      expires_at: '2026-11-04T02:20:00.000Z',
    },
    trace_id: TRACE,
  });
  await s.controller.download(s.request, USER, COPY, { regenerate: true }, h.reply);
  expect(s.downloaded[1]?.regenerate).toBe(true);
});

it.each([
  [{ kind: 'unknown_user' }, 400, { code: 20001, data: { fields: ['user_id'] } }],
  [{ kind: 'unknown_export' }, 400, { code: 20001, data: { fields: ['export_id'] } }],
  [
    { kind: 'permission_denied' },
    403,
    { code: 10403, data: { reason: 'admin_permission_denied' } },
  ],
  [
    { kind: 'not_downloadable', status: 'expired' },
    422,
    { code: 30417, data: { status: 'expired' } },
  ],
] as const)('[B1-27i] 下载拒绝 %o → HTTP %i', async (result, status, body) => {
  const s = setup({ kind: 'unknown_user' }, undefined, result);
  const answer = await refusal(s.controller.download(s.request, USER, COPY, {}, headers().reply));
  expect(answer.status).toBe(status);
  expect(answer.body).toMatchObject({ ...body, trace_id: TRACE });
});
