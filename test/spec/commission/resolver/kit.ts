// 合成数据库夹具；数据库生命周期只由 *.int.test.ts 管理。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { vi } from 'vitest';
import type {
  SnapshotBeneficiary,
  SnapshotBeneficiaryResolver,
} from '../../../../apps/api/src/modules/commission/application/snapshot.ts';
import type { GrowthHistory } from '../../../../apps/api/src/modules/growth/infra/history.ts';
import type { UserDeletionStatusReader } from '../../../../apps/api/src/modules/identity/ports/user-deletion-status.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';

// 运行时只走公开出口；URL 导入避免 test 项目编译 Nest 参数装饰器。
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  createSnapshotBeneficiaryResolver(options: {
    growth: GrowthHistory;
    deletion: UserDeletionStatusReader;
  }): SnapshotBeneficiaryResolver;
};
const growth = (await import(
  new URL('../../../../apps/api/src/modules/growth/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/growth/infra/history.ts');
const identity = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/identity/ports/user-deletion-status.ts');

export type Executor = Kysely<DB> | Transaction<DB>;
export const BEFORE = new Date('2026-10-01T00:00:00+08:00');
export const PAID = new Date('2026-10-20T10:00:00+08:00');
export const AFTER = new Date('2026-10-21T00:00:00+08:00');

export function fixture(db: Kysely<DB>) {
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: () => undefined },
  );
  const warn = vi.spyOn(logger, 'warn');
  const history = growth.createGrowthHistory({ logger });
  const deletion = identity.createUserDeletionStatusReader({ db });
  // spy 默认透传：每个读取仍由真实端口在 PostgreSQL 执行。
  const levelAt = vi.spyOn(history, 'levelAt');
  const parentAt = vi.spyOn(history, 'parentAt');
  const read = vi.spyOn(deletion, 'read');
  const resolver = commission.createSnapshotBeneficiaryResolver({ growth: history, deletion });
  return { resolver, levelAt, parentAt, read, warn };
}

export async function user(db: Executor, appId: string, status = 'normal'): Promise<string> {
  const id = randomUUID();
  await db
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'synthetic',
      avatar: 'https://example.invalid/avatar',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L3',
      status,
      register_method: 'sms',
      created_at: BEFORE,
      updated_at: AFTER,
    })
    .execute();
  return id;
}

export async function level(
  db: Executor,
  appId: string,
  userId: string,
  to: SnapshotBeneficiary['level'],
  at = BEFORE,
  from: SnapshotBeneficiary['level'] | null = null,
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('level_change_logs')
    .values({
      app_id: appId,
      user_id: userId,
      from_level: from,
      to_level: to,
      source: from === null ? 'register' : 'admin',
      operator: 'synthetic-test',
      reason: 'synthetic level change',
      effective_at: at,
      created_at: AFTER,
    })
    .execute();
}

export async function relation(
  db: Executor,
  appId: string,
  userId: string,
  to: string | null,
  at = BEFORE,
  from: string | null = null,
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('relation_change_logs')
    .values({
      app_id: appId,
      user_id: userId,
      from_parent_id: from,
      to_parent_id: to,
      source: 'admin',
      operator: 'synthetic-test',
      reason: 'synthetic relation change',
      at,
      created_at: AFTER,
    })
    .execute();
}

export function person(
  userId: string,
  value: SnapshotBeneficiary['level'],
  forfeited = false,
): SnapshotBeneficiary {
  return {
    userId,
    level: value,
    status: forfeited ? 'forfeited' : 'active',
    forfeitReason: forfeited ? 'deleted' : null,
  };
}

export async function chain(db: Executor) {
  const appId = `resolver-${randomUUID()}`;
  const owner = await user(db, appId);
  const direct = await user(db, appId);
  const indirect = await user(db, appId);
  const ancestor = await user(db, appId);
  await level(db, appId, owner, 'L1');
  await level(db, appId, direct, 'L2');
  await level(db, appId, indirect, 'L3');
  await level(db, appId, ancestor, 'L2');
  await relation(db, appId, owner, direct);
  await relation(db, appId, direct, indirect);
  await relation(db, appId, indirect, ancestor);
  return {
    appId,
    owner,
    direct,
    indirect,
    ancestor,
    input: { appId, ownerUserId: owner, paidAt: PAID },
    expected: {
      owner: person(owner, 'L1'),
      direct: person(direct, 'L2'),
      indirect: person(indirect, 'L3'),
      warnings: [],
    },
  };
}
