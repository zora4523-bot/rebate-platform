// 渠道单逐行处理（B1-09h）的连库夹具；只被 *.int.test.ts 引用，数据库生命周期在它们里管理。不引
// @couli/db/testing。名单写入用 risk 的真实端口（B1-09a，createOrderBlocklistPorts().importChannels，
// 外面套 spy 只为看调用），账号平台用 union 的真实 createUnionSyncAccess（同一个库）；处理器是本任务的
// createChannelImportProcessor。取值依据：08 BR-ATTR-26 ② 与细则「渠道单导入」、任务书补充（K-5：
// union_account_id 取任务、start_at = 任务受理时刻 created_at；重复口径同 B1-09a 端口）。
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable, Kysely, Selectable } from 'kysely';
import { vi } from 'vitest';
import {
  createChannelImportProcessor,
  type ChannelBlocklistPort,
  type ChannelImportDeps,
} from '../../../../apps/api/src/modules/orders/application/channel-import.ts';
import type {
  RightsImportCell,
  RightsImportRow,
  RightsImportRowProcessor,
  RightsImportTaskInfo,
} from '../../../../apps/api/src/modules/orders/application/rights-import-ports.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { createOrderBlocklistPorts as CreatePorts } from '../../../../apps/api/src/modules/risk/application/order-blocklist.ts';
import { createUnionSyncAccess } from '../../../../apps/api/src/modules/union/index.ts';

// Same as the risk / blacklist rule tests: the risk public surface is loaded at run time so its
// Nest controllers stay out of the pure TS test project.
const { createOrderBlocklistPorts } = (await import(
  new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url).href
)) as { createOrderBlocklistPorts: typeof CreatePorts };

/** 任务受理时刻（rights_imports.created_at）：2026-10-10T15:00+08:00，同 BR-ATTR-26 渠道单例。 */
export const IMPORTED = '2026-10-10T07:00:00.000Z';
/** 处理这一行时注入时钟的时刻（晚于受理）：start_at 不取它。 */
export const PROCESSED = '2026-10-10T07:05:00.000Z';
/** 种入的旧名单条目的时刻。 */
export const EARLIER = '2026-10-01T00:00:00.000Z';
/** 合成的渠道关系 ID（纯数字文本，任何格式口径都算合法）。 */
export const RELATION = '2876543210';
export const OTHER_RELATION = '2876543211';
export const THIRD_RELATION = '2876543212';
/** 带偏移的结束时刻文本与它对应的绝对时刻（2026-10-31T00:00+08:00）。 */
export const END_TEXT = '2026-10-31T00:00:00+08:00';
export const END_AT = '2026-10-30T16:00:00.000Z';

export const at = (iso: string) => new FixedClock(iso).now();
export function plusMs(iso: string, ms: number): Date {
  const clock = new FixedClock(iso);
  clock.advanceMs(ms);
  return clock.now();
}

export const INVALID_ROW = { kind: 'failed', reason: 'invalid_row' } as const;
export const PLATFORM_MISMATCH = { kind: 'failed', reason: 'platform_mismatch' } as const;

/** The part of @couli/db/testing's TestDatabase this kit uses. */
export interface TestDatabaseUrls {
  urlFor(role: 'couli_app'): string;
}

export async function open(database: TestDatabaseUrls) {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  return {
    db,
    async close() {
      await destroyDb(db);
    },
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;

export const newAppId = () => `ci_${randomUUID().replaceAll('-', '').slice(0, 24)}`;

export type BlocklistRow = Selectable<DB['blocklist']>;

export async function insertAccount(db: Kysely<DB>, appId: string, platform = 'taobao') {
  const id = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id,
      app_id: appId,
      platform,
      account_name: `synthetic-${id}`,
      status: 'active',
      auth_status: 'active',
    })
    .execute();
  return id;
}

/**
 * The processor's dependencies over `db`: risk's real channel import (spied) and union's real
 * account listing (spied); `clock` is the risk port's (it stamps created_at / updated_at only).
 */
export function channelDeps(db: Kysely<DB>, clock: FixedClock) {
  const key = randomBytes(32);
  const crypto = {
    blindIndex(value: string, context: string) {
      return createHmac('sha256', key).update(context).update('\0').update(value).digest('hex');
    },
  };
  const ports = createOrderBlocklistPorts({ clock, crypto });
  const importChannels = vi.fn<ChannelBlocklistPort['importChannels']>((trx, input) =>
    ports.importChannels(trx, input),
  );
  const union = createUnionSyncAccess({
    db,
    clock,
    endpoints: [],
    breaker: () => 'closed',
    logger: { error: vi.fn() },
  });
  const listEnabledAccounts = vi.fn<ChannelImportDeps['accounts']['listEnabledAccounts']>(() =>
    union.listEnabledAccounts(),
  );
  const deps: ChannelImportDeps = {
    db,
    blocklist: { importChannels },
    accounts: { listEnabledAccounts },
  };
  return { deps, importChannels, listEnabledAccounts };
}

/** One data row as the job hands it: the channel template's two columns. */
export function rowOf(
  relationId: RightsImportCell,
  endAt: RightsImportCell = null,
  rowNo = 2,
): RightsImportRow {
  return { row_no: rowNo, values: { relation_id: relationId, end_at: endAt } };
}

export async function entriesOf(db: Kysely<DB>, appId: string): Promise<BlocklistRow[]> {
  return db
    .selectFrom('blocklist')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/** An app with an admin and a taobao union account; tasks are channel imports of that account. */
export async function setup(db: Kysely<DB>) {
  const appId = newAppId();
  const adminId = randomUUID();
  const clock = new FixedClock(PROCESSED);
  const accountId = await insertAccount(db, appId);
  const { deps, importChannels, listEnabledAccounts } = channelDeps(db, clock);

  function task(patch: Partial<RightsImportTaskInfo> = {}): RightsImportTaskInfo {
    return {
      import_id: randomUUID(),
      app_id: appId,
      kind: 'channel',
      platform: 'taobao',
      union_account_id: accountId,
      time_basis: null,
      from: null,
      to: null,
      created_by: adminId,
      created_at: at(IMPORTED),
      ...patch,
    };
  }

  const processor = (): RightsImportRowProcessor => createChannelImportProcessor(deps);

  /** One row through a new processor, without the job's transaction. */
  async function run(
    relationId: RightsImportCell,
    endAt: RightsImportCell = null,
    patch: Partial<RightsImportTaskInfo> = {},
  ) {
    return processor().process(task(patch), rowOf(relationId, endAt));
  }

  /** A channel entry already in the blocklist (by default: this account, RELATION, in force). */
  async function seedEntry(patch: Partial<Insertable<DB['blocklist']>> = {}) {
    const id = randomUUID();
    await db
      .insertInto('blocklist')
      .values({
        id,
        app_id: appId,
        dimension: 'channel',
        value: RELATION,
        value_hmac: null,
        platform: 'taobao',
        union_account_id: accountId,
        start_at: at(EARLIER),
        end_at: null,
        expire_at: null,
        status: 'active',
        violation_type: 'other',
        created_by: 'fixture-admin',
        created_at: at(EARLIER),
        updated_at: at(EARLIER),
        ...patch,
      })
      .execute();
    return id;
  }

  return {
    db,
    appId,
    adminId,
    accountId,
    clock,
    deps,
    importChannels,
    listEnabledAccounts,
    task,
    processor,
    run,
    seedEntry,
    account: (platform = 'taobao', app = appId) => insertAccount(db, app, platform),
    entries: (app = appId) => entriesOf(db, app),
  };
}
export type Fixture = Awaited<ReturnType<typeof setup>>;

/** The columns of a new channel entry this task decides (the port fills id and the stamps). */
export function entryView(row: BlocklistRow) {
  return {
    app_id: row.app_id,
    dimension: row.dimension,
    value: row.value,
    value_hmac: row.value_hmac,
    platform: row.platform,
    union_account_id: row.union_account_id,
    start_at: row.start_at,
    end_at: row.end_at,
    expire_at: row.expire_at,
    status: row.status,
    violation_type: row.violation_type,
    created_by: row.created_by,
  };
}
