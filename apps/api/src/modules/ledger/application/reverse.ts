import type { DB } from '@couli/db';
import { uniqKey } from '@couli/domain';
import { InvalidAmount, subFen } from '@couli/money';
import type { Transaction } from 'kysely';
import { findVoucher, voucherEntries, type StoredEntry } from '../infra/store.ts';
import { LedgerError } from './errors.ts';
import {
  createPostingCore,
  type Ledger as PostingLedger,
  type PostingCoreOptions,
  type PostingEntry,
  type PostingResult,
  type PostingVoucher,
} from './ledger.ts';

export interface ReverseInput {
  readonly appId: string;
  readonly originalUniqKey: string;
}

export interface Ledger extends PostingLedger {
  /** Whole-voucher reversal in the caller's transaction, with its balance locks already held.
   * Preserve structured metadata; the :REVERSE key identifies the correction.
   * Refuse missing originals with ORIGINAL_NOT_FOUND and reversal keys with
   * CANNOT_REVERSE_REVERSAL. Replay returns the stored reversal's PostingResult.
   */
  reverse(trx: Transaction<DB>, input: ReverseInput): Promise<PostingResult>;
}

const REVERSE_SUFFIX = ':REVERSE';
const SUB_ACCOUNTS: readonly string[] = ['available', 'frozen'];
const ROLES: readonly (string | null)[] = ['self', 'share', 'direct', 'indirect', null];
const INCOME_TYPES: readonly (string | null)[] = ['SERVICE_FEE', 'INCIDENTAL', null];

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_INPUT', `${name} must be a nonempty string`);
  }
  return value;
}

/** BR-FUND-16: {原 uniq_key}:REVERSE, built by @couli/domain. */
function reversalKey(original: string): string {
  try {
    return uniqKey({ kind: 'REVERSE', original_uniq_key: original });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new LedgerError('INVALID_INPUT', `cannot build a reversal key: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * One stored entry negated (BR-FUND-16 红冲): same account and sub-account, same ledger_type /
 * sub_type / income_type (BR-FUND-15), amount_fen negated through @couli/money.
 */
function reversedEntry(row: StoredEntry): PostingEntry {
  if (!SUB_ACCOUNTS.includes(row.sub_account)) {
    throw new LedgerError('INVALID_VOUCHER', `stored entry has sub_account ${row.sub_account}`);
  }
  if (!INCOME_TYPES.includes(row.income_type)) {
    throw new LedgerError('INVALID_VOUCHER', `stored entry has income_type ${row.income_type}`);
  }
  let amount: bigint;
  try {
    amount = subFen(0n, row.amount_fen);
  } catch (error) {
    if (error instanceof InvalidAmount) {
      throw new LedgerError('INVALID_VOUCHER', 'stored amount cannot be negated', { cause: error });
    }
    throw error;
  }
  return {
    account:
      row.owner_type === 'user'
        ? { ownerType: 'user', accountId: row.account_id }
        : { ownerType: 'platform', subject: row.subject },
    sub_account: row.sub_account as PostingEntry['sub_account'],
    amount_fen: amount,
    ledger_type: row.ledger_type,
    sub_type: row.sub_type,
    income_type: row.income_type as PostingEntry['income_type'],
  };
}

/** Composes the B2-02f posting service (one Clock snapshot and lock registry) with reverse. */
export function createLedger(input: PostingCoreOptions): Ledger {
  const core = createPostingCore(input);
  return {
    ...core.ledger,

    async reverse(trx, request) {
      if (typeof request !== 'object' || request === null) {
        throw new LedgerError('INVALID_INPUT', 'reverse input must be an object');
      }
      const appId = text(request.appId, 'appId');
      const original = text(request.originalUniqKey, 'originalUniqKey');
      // Checked before the lookup: a reversal key is refused whether or not it exists.
      if (original.endsWith(REVERSE_SUFFIX)) {
        throw new LedgerError('CANNOT_REVERSE_REVERSAL', `${original} is itself a reversal`);
      }
      const voucher = await findVoucher(trx, appId, original);
      if (voucher === undefined) {
        throw new LedgerError('ORIGINAL_NOT_FOUND', `no voucher ${original} in app ${appId}`);
      }
      if (!ROLES.includes(voucher.role)) {
        throw new LedgerError('INVALID_VOUCHER', `stored voucher has role ${voucher.role}`);
      }
      const rows = await voucherEntries(trx, appId, voucher.id);
      const reversal: PostingVoucher = {
        appId,
        uniqKey: reversalKey(voucher.uniq_key),
        // Structured metadata is copied unchanged (decision 32); the key marks the correction.
        bizType: voucher.biz_type,
        bizId: voucher.biz_id,
        operator: voucher.operator,
        memo: voucher.memo,
        orderKey: voucher.order_key,
        beneficiaryUserId: voucher.beneficiary_user_id,
        role: voucher.role as PostingVoucher['role'],
        voucherKind: voucher.voucher_kind,
        entries: rows.map(reversedEntry),
      };
      // Lock check, duplicate read, BR-FUND-10 and the 23505 savepoint read-back are post's.
      return core.postReversal(trx, reversal);
    },
  };
}
