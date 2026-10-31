// B2-08b (规划/08 BR-WDR-20; 04 §3.2 tax_ytd 唯一 (app_id, user_id, year, income_type) + identity_hmac
// (B2-08a); task §9.2 1): payout's accumulator on the caller's transaction, with identity's real
// port. accumulate(trx, { appId, userId, withdrawalId, createdAt, amountFen, taxFen, now }):
//   the row (app, user, +08:00 year of createdAt, SERVICE_FEE, the verified real name's hmac) is
//   created with cum_income_fen = amountFen, cum_withheld_fen = taxFen (continuous_months 0, an
//   application UUIDv7 id, updated_at = now), or, when it exists, added to (one row, same id and
//   created_at, updated_at = the later now); identity is read on the same transaction;
//   tax_fen 0 (tax.SERVICE_FEE.method = none) still adds the income (BR-WDR-20 细则);
//   a caller's rollback leaves nothing; no verified real name → warn tax_ytd_identity_missing (ids
//   and year, never an hmac) and reject, nothing written; a negative amount is refused before
//   anything is written. Logs never carry the hmac.
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely, Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createRealnameIdentityKeyReader } from '../../../../apps/api/src/modules/identity/ports/realname-identity-key.ts';
import {
  createTaxYtdAccumulator,
  type TaxYtdAccumulateInput,
  type TaxYtdAccumulator,
  type TaxYtdIdentityKeyReader,
} from '../../../../apps/api/src/modules/payout/application/tax-ytd.ts';
import {
  IDENTITY_MISSING,
  TIMEOUT,
  UUID_V7,
  closeDb,
  expected,
  logText,
  openDb,
  randomHmac,
  seedMember,
  seedRealname,
  taxRows,
  totals,
  type DbHarness,
} from './kit.ts';

let h: DbHarness;
beforeAll(async () => {
  h = await openDb(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await closeDb(h);
}, TIMEOUT);

/** 2026-10-20 10:00 +08:00, the caller's Clock time of the first landing. */
const NOW = new Date('2026-10-20T02:00:00.000Z');
const LATER = new Date('2026-10-21T02:00:00.000Z');
/** A withdrawal created on 2026-10-19 09:58 +08:00. */
const CREATED_2026 = new Date('2026-10-19T09:58:00+08:00');

interface IdentityCall {
  readonly executor: Transaction<DB> | Kysely<DB>;
  readonly input: { readonly appId: string; readonly userId: string };
}

/** identity's real port, recording the executor and input of every read. */
function recordingIdentity(calls: IdentityCall[]): TaxYtdIdentityKeyReader {
  const real = createRealnameIdentityKeyReader();
  return {
    readIdentityKey(executor, input) {
      calls.push({ executor, input });
      return real.readIdentityKey(executor, input);
    },
  };
}

function build() {
  const calls: IdentityCall[] = [];
  const logger = { warn: vi.fn() };
  const accumulator = createTaxYtdAccumulator({ identity: recordingIdentity(calls), logger });
  return { accumulator, calls, logger };
}

async function member(withRealname: 'verified' | 'none' | 'failed' | 'absent') {
  const appId = `taxacc_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const userId = await seedMember(h.db, appId);
  const hmac = randomHmac();
  if (withRealname === 'verified') {
    await seedRealname(h.db, appId, userId, { status: 'verified', hmac });
  } else if (withRealname !== 'absent') {
    await seedRealname(h.db, appId, userId, { status: withRealname });
  }
  return { appId, userId, hmac };
}

function input(
  who: { appId: string; userId: string },
  patch: Partial<TaxYtdAccumulateInput> = {},
): TaxYtdAccumulateInput {
  return {
    appId: who.appId,
    userId: who.userId,
    withdrawalId: randomUUID(),
    createdAt: CREATED_2026,
    amountFen: 10_000n,
    taxFen: 2_000n,
    now: NOW,
    ...patch,
  };
}

/** accumulate on a transaction of its own (commits when it resolves); returns that transaction. */
async function run(
  accumulator: TaxYtdAccumulator,
  request: TaxYtdAccumulateInput,
): Promise<Transaction<DB>> {
  return h.db.transaction().execute(async (trx) => {
    await accumulator.accumulate(trx, request);
    return trx;
  });
}

async function settle(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

it('[AC-B2-08b#acc] 首笔：新建一行 (app, user, created_at 的 +08:00 年, SERVICE_FEE, 当前实名 hmac)，cum_income = amount、cum_withheld = tax（¥100 / 税 2000 分 → 10000 / 2000），continuous_months 0，id 为 UUIDv7，updated_at = 调用方时刻；身份在同一事务上按 (appId, userId) 读', async () => {
  const { accumulator, calls, logger } = build();
  const who = await member('verified');

  const trx = await run(accumulator, input(who));

  const rows = await taxRows(h.observer, who.appId);
  expect(rows.map(totals)).toEqual([
    expected(who.appId, who.userId, 2026, who.hmac, 10_000n, 2_000n),
  ]);
  expect(rows[0]!.id).toMatch(UUID_V7);
  expect(rows[0]!.updated_at).toEqual(NOW);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.executor).toBe(trx);
  expect(calls[0]!.input).toEqual({ appId: who.appId, userId: who.userId });
  expect(logText(logger)).not.toContain(who.hmac);
});

it('[AC-B2-08b#acc] 同一身份同一年第二笔累加到同一行（AC-S2-44 ③：¥100 + ¥200 → 30000 分）；税 0（method=none）也照常累加收入；id 与 created_at 不变、updated_at 为后一次的时刻', async () => {
  const { accumulator } = build();
  const who = await member('verified');

  await run(accumulator, input(who, { amountFen: 10_000n, taxFen: 0n }));
  const [first] = await taxRows(h.observer, who.appId);
  await run(accumulator, input(who, { amountFen: 20_000n, taxFen: 0n, now: LATER }));

  const rows = await taxRows(h.observer, who.appId);
  expect(rows.map(totals)).toEqual([expected(who.appId, who.userId, 2026, who.hmac, 30_000n, 0n)]);
  expect(rows[0]!.id).toBe(first!.id);
  expect(rows[0]!.created_at).toEqual(first!.created_at);
  expect(rows[0]!.updated_at).toEqual(LATER);
});

it('[AC-B2-08b#acc] 年度按 created_at 的 +08:00 自然年分行：12-31 23:30 +08:00 归当年，次年 01-01 00:30 +08:00（UTC 仍是前一年）归次年', async () => {
  const { accumulator } = build();
  const who = await member('verified');

  await run(
    accumulator,
    input(who, {
      createdAt: new Date('2026-12-31T23:30:00+08:00'),
      amountFen: 5_000n,
      taxFen: 100n,
    }),
  );
  await run(
    accumulator,
    input(who, {
      createdAt: new Date('2027-01-01T00:30:00+08:00'),
      amountFen: 7_000n,
      taxFen: 300n,
    }),
  );
  await run(
    accumulator,
    input(who, { createdAt: new Date('2026-06-30T12:00:00+08:00'), amountFen: 1_000n, taxFen: 0n }),
  );

  expect((await taxRows(h.observer, who.appId)).map(totals)).toEqual([
    expected(who.appId, who.userId, 2026, who.hmac, 6_000n, 100n),
    expected(who.appId, who.userId, 2027, who.hmac, 7_000n, 300n),
  ]);
});

it('[AC-B2-08b#acc] 写在调用方的事务里：调用方回滚 → 台账没有行', async () => {
  const { accumulator } = build();
  const who = await member('verified');
  const rollback = new Error('the landing failed after the accumulation');

  await expect(
    h.db.transaction().execute(async (trx) => {
      await accumulator.accumulate(trx, input(who));
      throw rollback;
    }),
  ).rejects.toBe(rollback);

  expect(await taxRows(h.observer, who.appId)).toEqual([]);
});

it.each(['absent', 'none', 'failed'] as const)(
  '[AC-B2-08b#acc] 未实名（realname %s）→ 抛错不吞、warn tax_ytd_identity_missing（带 withdrawal_id，不带 hmac），台账没有行',
  async (state) => {
    const { accumulator, logger } = build();
    const who = await member(state);
    const request = input(who);

    const error = await settle(run(accumulator, request));

    expect(error).toBeInstanceOf(Error);
    expect(await taxRows(h.observer, who.appId)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ withdrawal_id: request.withdrawalId }),
      IDENTITY_MISSING,
    );
    expect(logText(logger)).not.toContain(who.hmac);
  },
);

it.each([
  ['amountFen', { amountFen: -1n }],
  ['taxFen', { taxFen: -1n }],
] as const)(
  '[AC-B2-08b#acc] 金额为负（%s = -1）→ 拒绝，台账没有行（金额经 @couli/money 校验 ≥ 0）',
  async (_name, patch) => {
    const { accumulator } = build();
    const who = await member('verified');

    const error = await settle(run(accumulator, input(who, patch)));

    expect(error).toBeInstanceOf(Error);
    expect(await taxRows(h.observer, who.appId)).toEqual([]);
  },
);

it('[AC-B2-08b#acc] 实名更正后（新 hmac）另起一行，旧身份行不再累加；两行同 (user, year)', async () => {
  const { accumulator } = build();
  const who = await member('verified');
  const corrected = randomHmac();

  await run(accumulator, input(who, { amountFen: 10_000n, taxFen: 2_000n }));
  const [old] = await taxRows(h.observer, who.appId);
  await h.db
    .withSchema('app')
    .updateTable('realname')
    .set({ id_no_hmac: corrected })
    .where('app_id', '=', who.appId)
    .where('user_id', '=', who.userId)
    .execute();
  await run(accumulator, input(who, { amountFen: 20_000n, taxFen: 4_000n, now: LATER }));

  const rows = await taxRows(h.observer, who.appId);
  expect(rows).toHaveLength(2);
  expect(rows.map(totals)).toEqual(
    expect.arrayContaining([
      expected(who.appId, who.userId, 2026, who.hmac, 10_000n, 2_000n),
      expected(who.appId, who.userId, 2026, corrected, 20_000n, 4_000n),
    ]),
  );
  expect(rows.find((row) => row.identity_hmac === who.hmac)).toEqual(old);
});
