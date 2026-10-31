// B2-05o: payout's review overdue port against PostgreSQL. It counts, across every app_id, the
// withdrawals whose review_overdue_at is set and whose status is still PENDING_REVIEW or APPROVED
// (BR-WDR-26: 审核结束 = PAYING / PAID_MANUAL / REJECTED; terminal rows never count). The deadline
// alone never counts: a row past its deadline the check has not judged yet is not overdue here.
// It runs on a session whose every transaction is READ ONLY, so any write fails in PostgreSQL
// itself, and the rows are compared before and after. Each read sees the current rows (no cache in
// the port). Finally the worker registry renders the same value.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { readPayoutReviewOverdue } from '../../../../../apps/api/src/modules/payout/index.ts';
import { createMetricsRegistry } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { insertUser } from '../../fund-metrics/kit.ts';
import { readOnlyUrl } from '../kit.ts';
import {
  APP_A,
  OVERDUE_METRIC,
  insertOverdueRow,
  judge,
  overdueValue,
  seedOverdue,
  setStatus,
  withdrawalSnapshot,
} from './kit.ts';

async function open() {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const readOnly = createDb({ connectionString: readOnlyUrl(database), max: 2 });
  return {
    db,
    readOnly,
    async close() {
      await destroyDb(readOnly);
      await destroyDb(db);
      await database.drop();
    },
  };
}

it('[AC-B2-05o#3] 端口只计 review_overdue_at 非空且 status ∈ {PENDING_REVIEW, APPROVED} 的提现单（跨 app_id、不分审核方式）；已判定后转 PAYING / 终态 / 驳回的、过了截止时间但未判定的都不计；只读事务可跑、前后行不变', async () => {
  const t = await open();
  try {
    const seeded = await seedOverdue(t.db);
    // The session really is read-only: the port cannot write behind the test's back.
    const user = await insertUser(t.db, APP_A);
    await expect(
      insertOverdueRow(t.readOnly, {
        appId: APP_A,
        userId: user,
        status: 'PENDING_REVIEW',
        reviewMode: null,
        reviewDeadline: null,
        overdueAt: null,
      }),
      'fixture session must be read-only',
    ).rejects.toThrow(/read-only/);
    const before = await withdrawalSnapshot(t.db);

    const result = await readPayoutReviewOverdue(t.readOnly);
    expect(result).toEqual({ reviewOverdue: seeded.expected });
    expect(Number.isInteger(result.reviewOverdue), 'a whole count').toBe(true);

    expect(await withdrawalSnapshot(t.db), 'rows unchanged by the read').toEqual(before);
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-05o#4] 每次读取跟随当前行：计入的单被审核走（REJECTED / PAYING）即减一，新判定的单即加一（端口不缓存）；空库为 0', async () => {
  const t = await open();
  try {
    expect(await readPayoutReviewOverdue(t.readOnly), 'empty database').toEqual({
      reviewOverdue: 0,
    });
    const seeded = await seedOverdue(t.db);
    expect(await readPayoutReviewOverdue(t.readOnly)).toEqual({ reviewOverdue: seeded.expected });

    // A person rejects the counted withdrawal: the review ended, review_overdue_at stays set.
    await setStatus(t.db, seeded.pendingId, 'REJECTED');
    expect(await readPayoutReviewOverdue(t.readOnly)).toEqual({
      reviewOverdue: seeded.expected - 1,
    });

    // The check judges the row that was past its deadline: it joins.
    await judge(t.db, seeded.unjudgedId);
    expect(await readPayoutReviewOverdue(t.readOnly)).toEqual({ reviewOverdue: seeded.expected });

    // Approved and executed (PAYING): it leaves again.
    await setStatus(t.db, seeded.unjudgedId, 'PAYING');
    expect(await readPayoutReviewOverdue(t.readOnly)).toEqual({
      reviewOverdue: seeded.expected - 1,
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-05o#5] worker registry 以该端口为采集渲染：couli_withdrawals_review_overdue 无标签一条、值与夹具一致', async () => {
  const t = await open();
  try {
    const seeded = await seedOverdue(t.db);
    const registry = createMetricsRegistry({
      entry: 'worker',
      collectReviewOverdue: () => readPayoutReviewOverdue(t.readOnly),
    });
    const text = await registry.render();
    expect(overdueValue(text)).toBe(seeded.expected);
    expect(text).toMatch(new RegExp(`^${OVERDUE_METRIC} ${seeded.expected}$`, 'm'));
  } finally {
    await t.close();
  }
}, 60_000);
