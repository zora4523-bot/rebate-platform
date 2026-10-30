// B1-08zc（评审 r1 S1 第 1 条）：支 (i) 里的 REFUND 也必须单凭 reason 出单。别的文件里 REFUND 的例子都经
// PLATFORM_INVALID / INVALID_AFTER_SETTLE 进入，支 (ii) 会替它出单；这里进入事件都不在 (ii) 集合内。
// 常见情形：已入账订单结算后退款扣回（settlement 以 REFUND_AFTER_SETTLE 进入、写 reason=REFUND，编排 9.1），
// 平台之后把结算佣金恢复为 >0。
// 骗法：支 (i) 集合漏掉 REFUND（只认 RIGHTS / COMMISSION_ZERO）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  at,
  entryOf,
  expectedKeys,
  expectNotRevived,
  RECEIVED,
  RESTORE_ALERT,
  scenario,
  type Report,
  type RestoreSpec,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

interface Case {
  readonly label: string;
  readonly spec: RestoreSpec;
  readonly change: Report;
  readonly trigger: 'status' | 'commission';
  readonly platformAfter: string;
  readonly expectedFen: bigint;
}

const CASES: readonly Case[] = [
  {
    label:
      'CLAWED_BACK(REFUND)，结算后退款扣回（REFUND_AFTER_SETTLE），平台仍 SETTLED；结算佣金 0 → 1234',
    spec: {
      rebate: 'CLAWED_BACK',
      reason: 'REFUND',
      entry: { from: 'CREDITED', event: 'REFUND_AFTER_SETTLE', to: 'CLAWED_BACK' },
      imported: 'settled',
      settle: 0n,
    },
    change: { settle_commission_fen: 1234n },
    trigger: 'commission',
    platformAfter: 'SETTLED',
    expectedFen: 1234n,
  },
  {
    label: 'VOID(REFUND)，进入事件 RIGHTS_FULL（不在 (ii) 集合）；P9 → RECEIVED',
    spec: {
      rebate: 'VOID',
      reason: 'REFUND',
      entry: { from: 'ESTIMATED', event: 'RIGHTS_FULL', to: 'VOID' },
      imported: 'invalid',
      est: 432n,
    },
    change: { raw_status: 'received', received_at: at(RECEIVED) },
    trigger: 'status',
    platformAfter: 'RECEIVED',
    expectedFen: 432n,
  },
];

it.each(CASES)(
  '[AC-B1-08zc#23] 支 (i) 仅凭 reason=REFUND（进入事件不在 (ii) 集合）也出一张单：$label',
  async ({ spec, change, trigger, platformAfter, expectedFen }) => {
    const f = await scenario(db, spec);
    expect(await f.sync(change)).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect((await f.order()).platform_status).toBe(platformAfter);
    await expectNotRevived(f, spec.rebate, spec.reason);

    // 键手写：refId = {order_key}#RESTORE#{entry_id}，dedupe = platform_restore:{order_key}:{entry_id}。
    const entryId = entryOf(f).toString(10);
    const refId = `${f.key}#RESTORE#${entryId}`;
    const dedupeKey = `platform_restore:${f.key}:${entryId}`;
    expect(expectedKeys(f)).toEqual({ refId, dedupeKey });

    const diffs = await f.diffs();
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      type: 'platform_restore',
      source: 'R1',
      ref_type: 'order',
      ref_id: refId,
      dedupe_key: dedupeKey,
      expected_fen: expectedFen,
      actual_fen: 0n,
      diff_fen: expectedFen,
      status: 'open',
      resolution: {
        reason_code: 'REFUND',
        rebate_status: spec.rebate,
        trigger,
        platform_status: platformAfter,
      },
    });
    const warns = f.restoreWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.[0]).toMatchObject({
      alert: RESTORE_ALERT,
      app_id: f.ctx.app_id,
      order_id: f.original.order_id,
      recon_diff_id: diffs[0]?.id,
      trigger,
      reason_code: 'REFUND',
    });
  },
);
