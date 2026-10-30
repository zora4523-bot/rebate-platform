// B2-16b: ledger's writer of the invite reward vouchers, the implementation of growth's
// InviteRewardGrantWriter (08 BR-INV-24 ② ⑦, BR-FUND-15, BR-FUND-16; specs/ledger-templates.csv
// REWARD:INVITE: debit platform MKT_EXPENSE, credit the user's USER_BALANCE available, reward_fen).
//
// One voucher per paid party in the caller's transaction, uniq_key
// INVITE_REWARD:{invitee_user_id}:{side}, through the given ledger only (openUserAccount when the
// account is missing, lockBalances, post); a replayed key returns the stored voucher without a new
// entry; an amount of 0 writes nothing. Input checks run before any SQL (LedgerError INVALID_INPUT):
// amount a bigint >= 0, party inviter | invitee, the invitee side paid to the invitee and the
// inviter side to someone else, nonempty ids, a valid `at`.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { buildVouchers, type BuiltVoucher } from '@couli/domain';
import { InvalidAmount, parseFen } from '@couli/money';
import type { Transaction } from 'kysely';
import { findVoucherId } from '../infra/store.ts';
import { LedgerError } from './errors.ts';
import type { PostingEntry, PostingVoucher } from './ledger.ts';
import type { Ledger } from './reverse.ts';

/** The beneficiary side of an invite reward (the {side} of the uniq_key). */
export type InviteRewardSide = 'inviter' | 'invitee';

/** Same fields as growth's InviteRewardGrantInput. */
export interface InviteRewardGrantRequest {
  readonly app_id: string;
  /** The invitee: the idempotency subject of both vouchers. */
  readonly invitee_id: string;
  readonly party: InviteRewardSide;
  /** The beneficiary credited on this side. */
  readonly user_id: string;
  /** reward_fen, the per-party amount locked on the qualification record. */
  readonly amount_fen: bigint;
  readonly at: Date;
}

/**
 * posted: a new voucher; duplicate: the key was already booked, its voucher is returned and nothing
 * is written; zero: amount 0, no voucher (the key stays free).
 */
export type InviteRewardGrantOutcome =
  | { readonly kind: 'posted' | 'duplicate'; readonly voucher_id: string }
  | { readonly kind: 'zero'; readonly voucher_id: null };

export interface InviteRewardVoucherWriter {
  grant(trx: Transaction<DB>, input: InviteRewardGrantRequest): Promise<InviteRewardGrantOutcome>;
}

export interface InviteRewardGrantWriterDeps {
  /** The ledger every voucher and balance change goes through (its Clock, events and hooks). */
  readonly ledger: Ledger;
}

const TEMPLATE_ID = 'REWARD:INVITE';
const SIDES: readonly string[] = ['inviter', 'invitee'];
const BIZ_TYPE = 'INVITE_REWARD';
const OPERATOR = 'system';

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_INPUT', `${name} must be a nonempty string`);
  }
  return value;
}

interface CheckedRequest {
  readonly appId: string;
  readonly inviteeId: string;
  readonly side: InviteRewardSide;
  readonly userId: string;
  readonly amount: bigint;
}

/** Every check that needs no SQL; any failure is LedgerError INVALID_INPUT. */
function check(input: InviteRewardGrantRequest): CheckedRequest {
  if (typeof input !== 'object' || input === null) {
    throw new LedgerError('INVALID_INPUT', 'invite reward input must be an object');
  }
  const appId = text(input.app_id, 'app_id');
  const inviteeId = text(input.invitee_id, 'invitee_id');
  const userId = text(input.user_id, 'user_id');
  const side: unknown = input.party;
  if (typeof side !== 'string' || !SIDES.includes(side)) {
    throw new LedgerError('INVALID_INPUT', 'party must be inviter or invitee');
  }
  // The invitee's own reward goes to the invitee; the inviter's never does.
  if (side === 'invitee' && userId !== inviteeId) {
    throw new LedgerError('INVALID_INPUT', 'the invitee side must be paid to the invitee');
  }
  if (side === 'inviter' && userId === inviteeId) {
    throw new LedgerError('INVALID_INPUT', 'the inviter side cannot be paid to the invitee');
  }
  const raw: unknown = input.amount_fen;
  if (typeof raw !== 'bigint') {
    throw new LedgerError('INVALID_INPUT', 'amount_fen must be a bigint');
  }
  let amount: bigint;
  try {
    amount = parseFen(raw);
  } catch (error) {
    if (error instanceof InvalidAmount) {
      throw new LedgerError('INVALID_INPUT', 'amount_fen is out of range', { cause: error });
    }
    throw error;
  }
  if (amount < 0n) throw new LedgerError('INVALID_INPUT', 'amount_fen must not be negative');
  const at: unknown = input.at;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new LedgerError('INVALID_INPUT', 'at must be a valid Date');
  }
  return { appId, inviteeId, side: side as InviteRewardSide, userId, amount };
}

/** The REWARD:INVITE voucher from @couli/domain; [] for a zero amount. */
function build(request: CheckedRequest): readonly BuiltVoucher[] {
  try {
    return buildVouchers(TEMPLATE_ID, {
      invitee_user_id: request.inviteeId,
      side: request.side,
      user_id: request.userId,
      reward_fen: request.amount,
    });
  } catch (error) {
    if (error instanceof RangeError || error instanceof InvalidAmount) {
      throw new LedgerError('INVALID_INPUT', `invite reward voucher: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function postingVoucher(
  request: CheckedRequest,
  built: BuiltVoucher,
  accountId: string,
): PostingVoucher {
  const entries: PostingEntry[] = built.entries.map((entry) => ({
    account:
      entry.account.owner_type === 'user'
        ? { ownerType: 'user', accountId }
        : { ownerType: 'platform', subject: entry.account.subject },
    // Platform rows are stored as available (build-vouchers decision 29).
    sub_account: entry.sub_account ?? 'available',
    amount_fen: entry.amount_fen,
    ledger_type: entry.ledger_type,
    sub_type: entry.sub_type,
    income_type: null,
  }));
  return {
    appId: request.appId,
    uniqKey: built.uniq_key,
    bizType: BIZ_TYPE,
    bizId: request.inviteeId,
    operator: OPERATOR,
    memo: null,
    // Not tied to an order (BR-INV-24 ②, BR-FUND-01): no order_key, beneficiary or role.
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: null,
    entries,
  };
}

export function createInviteRewardGrantWriter(
  deps: InviteRewardGrantWriterDeps,
): InviteRewardVoucherWriter {
  const { ledger } = deps;
  return {
    async grant(trx, input) {
      const request = check(input);
      const built = build(request);
      if (built.length === 0) return { kind: 'zero', voucher_id: null };
      if (built.length !== 1) throw new Error('ledger: REWARD:INVITE built more than one voucher');
      const voucher = built[0]!;

      // A booked key is returned as is: no account opened, no lock taken, nothing written.
      const existing = await findVoucherId(trx, request.appId, voucher.uniq_key);
      if (existing !== undefined) return { kind: 'duplicate', voucher_id: existing };

      // BR-FUND-13 / BR-FUND-16: open the account if missing, lock its balance row, then post.
      await ledger.openUserAccount(trx, { appId: request.appId, userId: request.userId });
      const [locked] = await ledger.lockBalances(trx, {
        appId: request.appId,
        userIds: [request.userId],
      });
      if (locked === undefined) throw new Error('ledger: the beneficiary account has no balance');
      const result = await ledger.post(trx, postingVoucher(request, voucher, locked.account_id));
      return { kind: result.kind, voucher_id: result.voucherId };
    },
  };
}
