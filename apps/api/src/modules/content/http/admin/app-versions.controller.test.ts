import { HttpException } from '@nestjs/common';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  FixedClock,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import {
  AppVersionAdmin,
  AppVersionConflictError,
  type AdminAppVersionSaveBody,
  type AppVersionRecord,
} from '../../application/app-version-admin.ts';
import { AdminAppVersionsController } from './app-versions.controller.ts';

const APP = 'app_versions_ctrl';
const ADMIN = '00000000-0000-4000-8000-0000000000ab';
const AT = '2026-10-19T02:00:00.000Z';

class FakeGuard extends AdminOperationGuard {
  readonly calls: AdminOperationInput[] = [];
  readonly outcomes: string[] = [];

  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.calls.push(input);
    try {
      const result = await business({ adminId: ADMIN, appId: APP, isSuper: true, loginName: 'a' });
      this.outcomes.push('consumed');
      return result;
    } catch (error) {
      this.outcomes.push('released');
      throw error;
    }
  }
}

const body = (patch: Partial<AdminAppVersionSaveBody> = {}): AdminAppVersionSaveBody => ({
  latest_version: '1.2.0',
  min_supported_version: null,
  recommended_version: null,
  update_title: '',
  update_notes: '',
  store_url: 'https://store.example.test/app',
  default_store: 'store_a',
  store_listings: [{ store: 'store_a', listed_version: '1.2.0' }],
  confirmed_stores: [],
  expected_row_version: null,
  ...patch,
});

function fixture(current: AppVersionRecord | undefined, locked = current) {
  const guard = new FakeGuard();
  const reads: string[] = [];
  const admin = new AppVersionAdmin({
    store: {
      rows: async () => [],
      row: async (appId, platform, channel) => {
        reads.push(`${appId}:${platform}/${channel}`);
        return current;
      },
      transaction: async (work) =>
        work({
          lock: async () => locked,
          insert: async (_id, write) => ({ ...write.row, row_version: 0, updated_at: write.at }),
          update: async (write, rowVersion) => ({
            ...write.row,
            row_version: rowVersion + 1,
            updated_at: write.at,
          }),
          audit: async () => undefined,
        }),
    },
    clock: new FixedClock(AT),
    logger: { warn: () => undefined },
    newId: () => '01920000-0000-7000-8000-000000000003',
  });
  const request = {
    id: 'trace-1',
    ip: '127.0.0.1',
    adminPrincipal: { adminId: ADMIN, appId: APP, sessionId: 's', isSuper: true },
  };
  return { guard, reads, request, controller: new AdminAppVersionsController(guard, admin) };
}

const row = (patch: Partial<AppVersionRecord> = {}): AppVersionRecord => ({
  ...body(),
  platform: 'android',
  channel: 'official',
  row_version: 0,
  updated_at: new Date(AT),
  ...patch,
});

it('[AC-F1-02zc] 判档按守卫前预读的现行行：提高 min 带 operation，其余不带；读只读', async () => {
  const absent = fixture(undefined);
  await absent.controller.save(
    absent.request,
    'android',
    'official',
    body({ min_supported_version: '1.0.0' }),
  );
  expect(absent.reads).toEqual([`${APP}:android/official`]);
  expect(absent.guard.calls[0]).toMatchObject({
    permission: 'content.app_version',
    operation: 'content.app_version.raise_min_supported_version',
  });

  const lower = fixture(row({ min_supported_version: '1.1.0' }));
  await lower.controller
    .save(
      lower.request,
      'android',
      'official',
      body({ min_supported_version: '1.0.0', expected_row_version: 99 }),
    )
    .catch(() => undefined);
  expect(lower.guard.calls[0]).toEqual({
    request: lower.request,
    permission: 'content.app_version',
  });

  const reads = fixture(undefined);
  await reads.controller.list(reads.request);
  expect(reads.guard.calls[0]).toEqual({
    request: reads.request,
    permission: 'content.app_version',
    readOnly: true,
  });
  expect(reads.reads).toEqual([]);
});

it('[AC-F1-02zc] 业务拒绝穿过守卫抛出（不消耗令牌），映射 20902 / 30701', async () => {
  const f = fixture(row(), row({ row_version: 1 }));
  const error = await f.controller
    .save(f.request, 'android', 'official', body({ expected_row_version: 1 }))
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(409);
  expect((error as HttpException).getResponse()).toEqual({
    code: 20902,
    msg: '状态已变化，请刷新后重试',
    data: { resource: 'app_version' },
    trace_id: 'trace-1',
  });
  expect(f.guard.outcomes).toEqual(['released']);

  const missing = fixture(undefined);
  const notFound = await missing.controller
    .detail(missing.request, 'ios', 'appstore')
    .catch((caught: unknown) => caught);
  expect((notFound as HttpException).getResponse()).toEqual({
    code: 30701,
    msg: '内容不存在',
    trace_id: 'trace-1',
  });
  expect(new AppVersionConflictError()).toBeInstanceOf(Error);
});

it('[AC-F1-02zc] 成功保存返回信封，身份只取守卫 actor', async () => {
  const f = fixture(undefined);
  const response = await f.controller.save(f.request, 'android', 'official', body());
  expect(response).toMatchObject({ code: 0, msg: '', trace_id: 'trace-1' });
  expect(response.data).toMatchObject({ platform: 'android', row_version: 0, updated_at: AT });
  expect(f.guard.outcomes).toEqual(['consumed']);
});
