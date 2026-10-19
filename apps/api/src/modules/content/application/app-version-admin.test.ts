import { afterEach, expect, it, vi } from 'vitest';
import type { AuditInput } from '../../platform/index.ts';
import { FixedClock } from '../../platform/index.ts';
import * as validation from './app-version-admin-validation.ts';
import {
  AppVersionAdmin,
  AppVersionConflictError,
  AppVersionFieldsError,
  AppVersionNotFoundError,
  InvalidAdminAppVersionError,
  adminAppVersionView,
  needsRaiseStepUp,
  type AdminAppVersionSaveBody,
  type AppVersionAdminStore,
  type AppVersionPreRead,
  type AppVersionRecord,
  type AppVersionTx,
  type AppVersionWrite,
} from './app-version-admin.ts';

const APP = 'app_versions_unit';
const AT = '2026-10-19T02:00:00.000Z';
const ID = '01920000-0000-7000-8000-000000000001';
const actor = { appId: APP, adminId: 'admin-1', ip: null };

afterEach(() => {
  vi.restoreAllMocks();
});

function record(patch: Partial<AppVersionRecord> = {}): AppVersionRecord {
  return {
    platform: 'android',
    channel: 'official',
    latest_version: '1.2.0',
    min_supported_version: null,
    recommended_version: null,
    update_title: '',
    update_notes: '',
    store_url: 'https://store.example.test/app',
    default_store: 'store_a',
    store_listings: [
      { store: 'store_b', listed_version: '1.2.0' },
      { store: 'store_a', listed_version: '1.2.0' },
    ],
    row_version: 0,
    updated_at: new Date(AT),
    ...patch,
  };
}

function body(patch: Partial<AdminAppVersionSaveBody> = {}): AdminAppVersionSaveBody {
  return {
    latest_version: '1.2.0',
    min_supported_version: null,
    recommended_version: null,
    update_title: '',
    update_notes: '',
    store_url: 'https://store.example.test/app',
    default_store: 'store_a',
    store_listings: [
      { store: 'store_b', listed_version: '1.2.0' },
      { store: 'store_a', listed_version: '1.2.0' },
    ],
    confirmed_stores: [],
    expected_row_version: null,
    ...patch,
  };
}

function pre(row: AppVersionRecord | undefined): AppVersionPreRead {
  return {
    appId: APP,
    platform: 'android',
    channel: 'official',
    row:
      row === undefined
        ? null
        : { row_version: row.row_version, min_supported_version: row.min_supported_version },
  };
}

function stored(write: AppVersionWrite, rowVersion: number): AppVersionRecord {
  return { ...write.row, row_version: rowVersion, updated_at: write.at };
}

function fixture(options: {
  rows?: AppVersionRecord[];
  locked?: AppVersionRecord;
  insert?: (write: AppVersionWrite) => AppVersionRecord | undefined;
  storeKeys?: readonly string[];
}) {
  const clock = new FixedClock(AT);
  const warn = vi.fn();
  const audits: AuditInput[] = [];
  const writes: string[] = [];
  const tx: AppVersionTx = {
    lock: vi.fn(async () => options.locked),
    insert: vi.fn(async (_id: string, write: AppVersionWrite) => {
      writes.push('insert');
      return options.insert === undefined ? stored(write, 0) : options.insert(write);
    }),
    update: vi.fn(async (write: AppVersionWrite, rowVersion: number) => {
      writes.push('update');
      return stored(write, rowVersion + 1);
    }),
    audit: vi.fn(async (input: AuditInput) => {
      audits.push(input);
    }),
  };
  const transactionCalls = vi.fn();
  const transaction = <T>(work: (handle: AppVersionTx) => Promise<T>): Promise<T> => {
    transactionCalls();
    return work(tx);
  };
  const store: AppVersionAdminStore = {
    rows: async () => options.rows ?? [],
    row: async () => options.locked,
    transaction,
  };
  const admin = new AppVersionAdmin({
    store,
    clock,
    logger: { warn },
    newId: () => ID,
    ...(options.storeKeys === undefined ? {} : { storeKeys: () => options.storeKeys! }),
  });
  return { admin, warn, audits, writes, transaction: transactionCalls, tx, clock };
}

it('[AC-F1-02zc] 列表按端、渠道排序，跳过不合契约的行并以 content_app_version_invalid 告警', async () => {
  const f = fixture({
    rows: [
      record({ platform: 'h5' }),
      record({ channel: 'unknown_channel' }),
      record({ platform: 'admin' }),
      record({ channel: 'huawei', store_listings: [{}] }),
      record({ platform: 'android', channel: 'huawei' }),
    ],
  });
  const page = await f.admin.list(APP);
  expect(page.items.map((row) => `${row.platform}/${row.channel}`)).toEqual([
    'admin/official',
    'android/huawei',
    'h5/official',
  ]);
  expect(f.warn).toHaveBeenCalledTimes(2);
  expect(f.warn.mock.calls.map((call) => call[1])).toEqual([
    'content_app_version_invalid',
    'content_app_version_invalid',
  ]);
  expect(f.warn.mock.calls.map((call) => (call[0] as { column: string }).column)).toEqual([
    'channel',
    'store_listings',
  ]);
});

it('[AC-F1-02zc] 单取：无行 30701，脏行抛内部错误（50001），时间用 toISOString', async () => {
  await expect(fixture({}).admin.get(APP, 'ios', 'appstore')).rejects.toBeInstanceOf(
    AppVersionNotFoundError,
  );
  await expect(
    fixture({ locked: record({ store_url: 'not a uri' }) }).admin.get(APP, 'android', 'official'),
  ).rejects.toBeInstanceOf(InvalidAdminAppVersionError);
  const view = await fixture({ locked: record() }).admin.get(APP, 'android', 'official');
  expect(view.updated_at).toBe('2026-10-19T02:00:00.000Z');
  expect(view.store_listings).toEqual(record().store_listings);
});

it.each([
  [{ store_listings: [{ store: 'a', listed_version: '01.0.0' }] }, 'store_listings'],
  [{ store_listings: [{ store: 'a', listed_version: null, extra: 1 }] }, 'store_listings'],
  [{ store_listings: 'x' }, 'store_listings'],
  [{ latest_version: '1.0' }, 'latest_version'],
  [{ min_supported_version: 'x' }, 'min_supported_version'],
  [{ default_store: '' }, 'default_store'],
  [{ platform: 'web' }, 'platform'],
  [{ row_version: -1 }, 'row_version'],
  [{ updated_at: new Date(Number.NaN) }, 'updated_at'],
] as const)('[AC-F1-02zc] 不合 AdminAppVersion 的行 %j → %s', (patch, column) => {
  expect(() => adminAppVersionView(record(patch as Partial<AppVersionRecord>))).toThrow(
    expect.objectContaining({ column }),
  );
});

it('[AC-F1-02zc] 格式 20001 先于 CAS 20902：不进事务', async () => {
  const f = fixture({ locked: record() });
  await expect(
    f.admin.save(
      actor,
      'android',
      'official',
      body({ store_url: 'http://store.example.test/a', expected_row_version: 99 }),
      pre(record()),
    ),
  ).rejects.toEqual(new AppVersionFieldsError(['store_url']));
  expect(f.transaction).not.toHaveBeenCalled();
});

it('[AC-F1-02zc] 商店表为空时只校格式并告警，消息点明未登记商店键', async () => {
  const f = fixture({ storeKeys: [] });
  await f.admin.save(actor, 'android', 'official', body(), pre(undefined));
  expect(f.warn).toHaveBeenCalledTimes(1);
  expect(f.warn.mock.calls[0]![0]).toEqual({
    app_id: APP,
    platform: 'android',
    channel: 'official',
  });
  expect(f.warn.mock.calls[0]![1]).toBe(
    'content_app_version_store_keys_unset: specs/app-stores.yaml has no store key for this platform and channel; only the key format was checked',
  );
  const filled = fixture({ storeKeys: ['store_a', 'store_b'] });
  await filled.admin.save(actor, 'android', 'official', body(), pre(undefined));
  expect(filled.warn).not.toHaveBeenCalled();
});

it('[AC-F1-02zc] 非空表：确认了表外的键 → [confirmed_stores]', async () => {
  const f = fixture({ storeKeys: ['store_a', 'store_b'] });
  await expect(
    f.admin.save(
      actor,
      'android',
      'official',
      body({ confirmed_stores: ['store_x'] }),
      pre(undefined),
    ),
  ).rejects.toEqual(new AppVersionFieldsError(['confirmed_stores']));
});

it('[AC-F1-02zc] 默认商店键来自 storeKeysFor（按调用读取，可在边界替换）', async () => {
  const spy = vi.spyOn(validation, 'storeKeysFor').mockReturnValue(['store_a']);
  const f = fixture({});
  await expect(f.admin.save(actor, 'android', 'official', body(), pre(undefined))).rejects.toEqual(
    new AppVersionFieldsError(['store_listings']),
  );
  expect(spy).toHaveBeenCalledWith('android', 'official');
});

it.each([
  ['有行而 expected 为 null', record(), null],
  ['无行而 expected 为数字', undefined, 0],
  ['expected 不等于 row_version', record({ row_version: 3 }), 2],
] as const)('[AC-F1-02zc] CAS：%s → 20902，不写不审计', async (_name, locked, expected) => {
  const f = fixture({ ...(locked === undefined ? {} : { locked }) });
  await expect(
    f.admin.save(
      actor,
      'android',
      'official',
      body({ expected_row_version: expected }),
      pre(locked),
    ),
  ).rejects.toBeInstanceOf(AppVersionConflictError);
  expect(f.writes).toEqual([]);
  expect(f.audits).toEqual([]);
});

it.each([
  ['预读无行、加锁后有行', undefined, record()],
  ['预读有行、加锁后无行', record(), undefined],
  ['预读后 row_version 变化', record({ row_version: 0 }), record({ row_version: 1 })],
] as const)(
  '[AC-F1-02zc] 预读与加锁不一致（%s）→ 20902，即使 expected 匹配',
  async (_name, before, locked) => {
    const f = fixture({ ...(locked === undefined ? {} : { locked }) });
    await expect(
      f.admin.save(
        actor,
        'android',
        'official',
        body({ expected_row_version: locked === undefined ? null : locked.row_version }),
        pre(before),
      ),
    ).rejects.toBeInstanceOf(AppVersionConflictError);
    expect(f.writes).toEqual([]);
  },
);

it('[AC-F1-02zc] 并发新建撞唯一约束（insert 未写入）→ 20902，不是 50001', async () => {
  const f = fixture({ insert: () => undefined });
  await expect(
    f.admin.save(actor, 'android', 'official', body(), pre(undefined)),
  ).rejects.toBeInstanceOf(AppVersionConflictError);
  expect(f.audits).toEqual([]);
});

it('[AC-F1-02zc] 新建：UUIDv7 取写入时刻，审计 before 为 null、after 含整行与 confirmed_stores', async () => {
  const f = fixture({});
  const newId = vi.fn(() => ID);
  const admin = new AppVersionAdmin({
    store: {
      rows: async () => [],
      row: async () => undefined,
      transaction: async (work) =>
        work({
          lock: async () => undefined,
          insert: async (_id, write) => stored(write, 0),
          update: async () => undefined,
          audit: async (input) => {
            f.audits.push(input);
          },
        }),
    },
    clock: f.clock,
    logger: { warn: f.warn },
    newId,
  });
  const saved = await admin.save(actor, 'android', 'official', body(), pre(undefined));
  expect(newId).toHaveBeenCalledWith(new Date(AT));
  expect(saved).toMatchObject({ row_version: 0, updated_at: AT, platform: 'android' });
  expect(f.audits).toEqual([
    {
      appId: APP,
      actor: 'admin-1',
      action: 'app_version_save',
      target: 'android/official',
      before: null,
      after: {
        platform: 'android',
        channel: 'official',
        latest_version: '1.2.0',
        min_supported_version: null,
        recommended_version: null,
        update_title: '',
        update_notes: '',
        store_url: 'https://store.example.test/app',
        default_store: 'store_a',
        store_listings: body().store_listings,
        row_version: 0,
        confirmed_stores: [],
      },
      ip: null,
    },
  ]);
});

it('[AC-F1-02zc] 更新：原值保存也 +1；审计只记实际低于 min 的确认商店，按登记顺序', async () => {
  const locked = record({
    min_supported_version: '1.1.0',
    store_listings: [
      { store: 'store_a', listed_version: '1.2.0' },
      { store: 'store_b', listed_version: '1.2.0' },
      { store: 'store_c', listed_version: '1.2.0' },
    ],
  });
  const f = fixture({ locked });
  const same = await f.admin.save(
    actor,
    'android',
    'official',
    body({
      min_supported_version: '1.1.0',
      store_listings: locked.store_listings as AdminAppVersionSaveBody['store_listings'],
      expected_row_version: 0,
    }),
    pre(locked),
  );
  expect(same.row_version).toBe(1);
  expect(f.audits[0]!.after).toMatchObject({ confirmed_stores: [] });

  const lagging = fixture({ locked });
  await lagging.admin.save(
    actor,
    'android',
    'official',
    body({
      min_supported_version: '1.1.0',
      store_listings: [
        { store: 'store_a', listed_version: '1.2.0' },
        { store: 'store_c', listed_version: null },
        { store: 'store_b', listed_version: '1.0.0' },
      ],
      confirmed_stores: ['store_b', 'store_a', 'store_c'],
      expected_row_version: 0,
    }),
    pre(locked),
  );
  expect(lagging.audits[0]!.before).toMatchObject({
    row_version: 0,
    min_supported_version: '1.1.0',
  });
  expect(lagging.audits[0]!.after).toMatchObject({
    row_version: 1,
    confirmed_stores: ['store_c', 'store_b'],
  });
});

it('[AC-F1-02zc] 核对用加锁后的现行行：提高 min 越过默认商店 → [min_supported_version]', async () => {
  const locked = record({
    min_supported_version: '1.0.0',
    store_listings: [{ store: 'store_a', listed_version: '1.0.0' }],
  });
  const f = fixture({ locked });
  await expect(
    f.admin.save(
      actor,
      'android',
      'official',
      body({
        min_supported_version: '1.1.0',
        store_listings: [{ store: 'store_a', listed_version: '1.0.0' }],
        expected_row_version: 0,
      }),
      pre(locked),
    ),
  ).rejects.toEqual(new AppVersionFieldsError(['min_supported_version']));
  expect(f.writes).toEqual([]);
});

it('[AC-F1-02zc] 现行行登记畸形时按无登记处理，核对照常进行', async () => {
  const locked = record({ min_supported_version: '1.1.0', store_listings: [{}] });
  const f = fixture({ locked });
  await expect(
    f.admin.save(
      actor,
      'android',
      'official',
      body({
        min_supported_version: '1.1.0',
        store_listings: [{ store: 'store_a', listed_version: '1.0.0' }],
        expected_row_version: 0,
      }),
      pre(locked),
    ),
  ).rejects.toEqual(new AppVersionFieldsError(['store_listings']));
});

it('[AC-F1-02zc] 预读不属于本次保存 → 内部错误', async () => {
  const f = fixture({});
  await expect(f.admin.save(actor, 'android', 'huawei', body(), pre(undefined))).rejects.toThrow(
    'pre-read',
  );
});

it.each([
  [null, null, false],
  [null, '1.0.0', true],
  ['absent', '1.0.0', true],
  ['absent', null, false],
  ['1.0.0', '1.0.0', false],
  ['1.0.0', '0.9.0', false],
  ['1.0.0', '1.0.1', true],
  ['1.0.0', null, false],
] as const)('[AC-F1-02zc] 判档：现行 %s → 保存 %s 需要 totp=%s', (before, next, raise) => {
  const row =
    before === 'absent' ? undefined : record({ min_supported_version: before as string | null });
  expect(needsRaiseStepUp(pre(row), { min_supported_version: next })).toBe(raise);
});
