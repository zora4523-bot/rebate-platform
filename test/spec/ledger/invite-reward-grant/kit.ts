import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  createInviteRewardGrantWriter,
  createLedger,
  type BalanceRecoveredHook,
  type InviteRewardGrantRequest,
  type InviteRewardSide,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { INSTANT, snapshot } from '../posting/kit.ts';

export {
  TIMEOUT,
  INSTANT,
  account,
  bounded,
  close,
  open,
  post,
  snapshot,
  waitBlocked,
  type Harness,
} from '../posting/kit.ts';

/** specs/ledger-templates.csv REWARD:INVITE (lines 252–253). */
export const LEDGER_TYPE = 'REWARD';
export const SUB_TYPE = 'invite';
export const PLATFORM_SUBJECT = 'MKT_EXPENSE';

/** specs/ledger-rules.md §3: INVITE_REWARD:{invitee_user_id}:{side}. */
export function rewardKey(inviteeId: string, side: InviteRewardSide): string {
  return `INVITE_REWARD:${inviteeId}:${side}`;
}

export interface ContextOptions {
  readonly instant?: string;
  readonly hook?: BalanceRecoveredHook;
}

/** Called inside each it: in the red phase the writer factory throws NotImplemented per case. */
export function context(options: ContextOptions = {}) {
  const clock = new FixedClock(options.instant ?? INSTANT);
  const ledger = createLedger({
    clock,
    ...(options.hook === undefined ? {} : { balanceRecoveredHook: options.hook }),
  });
  const writer = createInviteRewardGrantWriter({ ledger });
  return { clock, ledger, writer, appId: `invite-grant-${randomUUID()}` };
}

export function request(
  appId: string,
  inviteeId: string,
  party: InviteRewardSide,
  userId: string,
  amount: bigint,
  instant: string = INSTANT,
): InviteRewardGrantRequest {
  return {
    app_id: appId,
    invitee_id: inviteeId,
    party,
    user_id: userId,
    amount_fen: amount,
    at: new FixedClock(instant).now(),
  };
}

type State = Awaited<ReturnType<typeof snapshot>>;

/** The entries of one voucher with their account owner and subject, platform line first. */
export function voucherLines(state: State, voucherId: string) {
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  return state.entries
    .filter((e) => e.voucher_id === voucherId)
    .map((e) => {
      const owner = accounts.get(e.account_id);
      expect(owner).toBeDefined();
      return {
        owner_type: owner?.owner_type,
        owner_id: owner?.owner_id,
        subject: owner?.subject,
        sub_account: e.sub_account,
        amount_fen: e.amount_fen,
        ledger_type: e.ledger_type,
        sub_type: e.sub_type,
        balance_after_fen: e.balance_after_fen,
        account_version: e.account_version,
      };
    })
    .sort((a, b) => (a.owner_type === b.owner_type ? 0 : a.owner_type === 'platform' ? -1 : 1));
}

/** The two lines of REWARD:INVITE for one beneficiary, platform first. */
export function expectedLines(
  userId: string,
  amount: bigint,
  balanceAfter: bigint,
  version: bigint,
) {
  return [
    {
      owner_type: 'platform',
      owner_id: 'platform',
      subject: PLATFORM_SUBJECT,
      sub_account: 'available',
      amount_fen: amount,
      ledger_type: LEDGER_TYPE,
      sub_type: SUB_TYPE,
      balance_after_fen: null,
      account_version: null,
    },
    {
      owner_type: 'user',
      owner_id: userId,
      subject: 'USER_BALANCE',
      sub_account: 'available',
      amount_fen: -amount,
      ledger_type: LEDGER_TYPE,
      sub_type: SUB_TYPE,
      balance_after_fen: balanceAfter,
      account_version: version,
    },
  ];
}

/** User accounts of the app, by owner id. */
export function userOwners(state: State): string[] {
  return state.accounts
    .filter((a) => a.owner_type === 'user')
    .map((a) => a.owner_id)
    .sort();
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

export async function accountingDays(db: Kysely<DB>, appId: string): Promise<string[]> {
  // PostgreSQL date rendered as text, independent of the runner timezone.
  const rows = await db
    .selectFrom('ledger_vouchers')
    .select((eb) => eb.cast<string>('accounting_date', 'text').as('day'))
    .where('app_id', '=', appId)
    .execute();
  return rows.map((r) => r.day);
}
