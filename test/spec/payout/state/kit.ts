import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { WithdrawalState } from '@couli/domain';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import type { ReceivedEvent } from '../../../../apps/api/src/modules/platform/events/types.ts';
import {
  createWithdrawalCommands,
  type WithdrawalAttemptResult,
  type WithdrawalCommandsOptions,
} from '../../../../apps/api/src/modules/payout/application/withdrawal-commands.ts';
import { fixture, success, state, type Harness, type Fixture } from '../apply/kit.ts';
import { voucher } from '../../ledger/posting/kit.ts';

export { close, open, TIMEOUT, invariant, fund, seedUser } from '../apply/kit.ts';
export type { Harness, Fixture } from '../apply/kit.ts';

export async function setup(h: Harness, balance = 10000n) {
  const f = await fixture(h, { balance });
  const attempts = new Map<
    string,
    { kind: 'transfer' | 'query'; result: WithdrawalAttemptResult }[]
  >();
  const options: WithdrawalCommandsOptions = {
    clock: f.clock,
    ledger: f.ledger,
    eventBus: f.options.eventBus!,
    lockUsersForUpdate: vi.fn(lockUsersForUpdate),
    attempts: {
      hasAttempt: vi.fn(async (_trx, id, kinds, results) =>
        (attempts.get(id) ?? []).some(
          (a) => kinds.includes(a.kind) && (!results || results.includes(a.result)),
        ),
      ),
    },
  };
  const reviewerId = randomUUID();
  async function startWithdrawal(amount = 100n) {
    return success(await h.db.transaction().execute((trx) => f.apply(trx, amount))).withdrawal_id;
  }
  function command(id: string, status: WithdrawalState = 'PENDING_REVIEW', version = 0) {
    return {
      appId: f.actor.appId,
      withdrawalId: id,
      expectedStatus: status,
      expectedRowVersion: version,
      reviewerId,
    };
  }
  return {
    ...f,
    commandOptions: options,
    attempts,
    reviewerId,
    startWithdrawal,
    command,
    commands: () => createWithdrawalCommands(options),
  };
}
export type StateFixture = Awaited<ReturnType<typeof setup>>;

export async function changeAvailable(f: Fixture, delta: bigint) {
  await f.h.db.transaction().execute(async (trx) => {
    await lockUsersForUpdate(trx, { appId: f.actor.appId, userIds: [f.actor.userId] });
    const [balance] = await f.ledger.lockBalances(trx, {
      appId: f.actor.appId,
      userIds: [f.actor.userId],
    });
    const v = voucher(f.actor.appId, balance!.account_id, -delta);
    await f.ledger.post(trx, {
      ...v,
      entries: v.entries.map((e) => ({ ...e, ledger_type: 'ADMIN_ADJUST' })),
    });
  });
}

export async function withdrawal(f: Fixture, id: string, db: Kysely<DB> = f.h.db) {
  return db
    .withSchema('app')
    .selectFrom('withdrawals')
    .selectAll()
    .where('app_id', '=', f.actor.appId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}
export async function snapshot(f: Fixture, db: Kysely<DB> = f.h.db) {
  return {
    ...(await state(f, db)),
    events: await db
      .withSchema('app')
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', f.actor.appId)
      .orderBy('id')
      .execute(),
    returns: await db
      .withSchema('app')
      .selectFrom('ledger_entries')
      .selectAll()
      .where('app_id', '=', f.actor.appId)
      .where('ledger_type', '=', 'WITHDRAW_RETURN')
      .orderBy('id')
      .execute(),
    holds: await db
      .withSchema('app')
      .selectFrom('withdraw_holds')
      .selectAll()
      .where('app_id', '=', f.actor.appId)
      .orderBy('id')
      .execute(),
  };
}
/** Seed only: states outside this task are not simulated by a fake production command. */
export async function seedStatus(f: Fixture, id: string, status: WithdrawalState) {
  await f.h.db
    .withSchema('app')
    .updateTable('withdrawals')
    .set({
      status,
      reject_reason_code: status === 'REJECTED' ? 'USER_REQUEST' : null,
      paid_at: status === 'PAID_API' || status === 'PAID_MANUAL' ? f.clock.now() : null,
      manual_entry_by: status === 'PAID_MANUAL' ? randomUUID() : null,
      manual_confirm_by: status === 'PAID_MANUAL' ? randomUUID() : null,
    })
    .where('id', '=', id)
    .execute();
}
export function negativeEvent(f: Fixture): ReceivedEvent {
  return {
    eventId: randomUUID(),
    appId: f.actor.appId,
    name: 'account.went_negative',
    version: 1,
    occurredAt: f.clock.now().toISOString(),
    consumer: 'payout-went-negative',
    attempt: 1,
    payload: { user_id: f.actor.userId },
  };
}
export async function expectReturn(f: Fixture, id: string, amount: bigint) {
  const s = await snapshot(f);
  const vouchers = s.vouchers.filter((v) => v.uniq_key === `wd:${id}:RETURN`);
  expect(vouchers).toHaveLength(1);
  const entries = s.returns.filter((e) => e.voucher_id === vouchers[0]!.id);
  // User subaccounts are liabilities: signed entry amounts are opposite to balance deltas.
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sub_account: 'frozen', amount_fen: amount }),
      expect.objectContaining({ sub_account: 'available', amount_fen: -amount }),
    ]),
  );
  expect(entries).toHaveLength(2);
}
