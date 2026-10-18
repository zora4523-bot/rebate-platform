import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import { at, fresh, type SnapshotPort } from './db-kit.ts';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';

// Same public runtime import as the existing commission suite: avoid pulling Nest
// controllers into the test project's erasable-syntax-only type graph.
const { createCommissionSnapshot, createInMemoryBeneficiaryResolver } = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  createCommissionSnapshot: typeof import('../../../../apps/api/src/modules/commission/application/snapshot.ts').createCommissionSnapshot;
  createInMemoryBeneficiaryResolver: typeof import('../../../../apps/api/src/modules/commission/infra/in-memory-beneficiary-resolver.ts').createInMemoryBeneficiaryResolver;
};

export async function realPort(db: Kysely<DB>, f: Awaited<ReturnType<typeof fresh>>) {
  const v = version({
    effective_from: at('2026-10-10T02:03:04Z'),
    indirect_enabled: false,
    rules: [
      {
        platform: 'pdd',
        level: 'L1',
        order_type: 'share',
        r_own_bp: 5000,
        r_direct_bp: 0,
        r_indirect_bp: 0,
      },
    ],
    reserves: [{ platform: 'pdd', reserve_bp: 1000 }],
  });
  await seedVersion(db, f.ctx.app_id, v);
  const beneficiaries = createInMemoryBeneficiaryResolver([
    {
      appId: f.ctx.app_id,
      beneficiaries: {
        owner: { userId: f.userId, level: 'L1', status: 'active', forfeitReason: null },
        direct: null,
        indirect: null,
        warnings: [],
      },
    },
  ]);
  const create = vi.fn<SnapshotPort['create']>((trx, input) =>
    createCommissionSnapshot(trx, input, {
      clock: f.clock,
      logger: { warn: vi.fn() },
      beneficiaries,
    }),
  );
  return { create, version: v };
}

export async function splits(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('commission_splits')
    .selectAll()
    .where('app_id', '=', appId)
    .execute();
}
