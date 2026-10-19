import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  accountingDate,
  applyEntries,
  mayGoNegative,
  validateVoucher,
  type LedgerBalance,
  type LedgerEntry,
  type NegativeBalanceInput,
} from '@couli/domain';
import { subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import {
  USER_SUBJECT,
  ensurePlatformAccounts,
  ensureUserAccount,
  findVoucherId,
  inSavepoint,
  insertEntries,
  insertVoucher,
  isUniqKeyViolation,
  lockBalancesByUser,
  readBalancesByUser,
  relockHeldBalances,
  updateBalance,
  userAccountsOfApp,
  type BalanceRow,
  type EntryInsert,
} from '../infra/store.ts';
import { LedgerError } from './errors.ts';

export type LedgerAccountRef =
  | { readonly ownerType: 'user'; readonly accountId: string }
  | { readonly ownerType: 'platform'; readonly subject: string };

export interface PostingEntry {
  readonly account: LedgerAccountRef;
  /** Storage sub-account. Platform entries use available; domain projection uses null. */
  readonly sub_account: 'available' | 'frozen';
  readonly amount_fen: bigint;
  readonly ledger_type: string;
  readonly sub_type: string | null;
  readonly income_type: 'SERVICE_FEE' | 'INCIDENTAL' | null;
}

export interface PostingVoucher {
  readonly appId: string;
  readonly uniqKey: string;
  readonly bizType: string;
  readonly bizId: string;
  readonly operator: string;
  readonly memo: string | null;
  readonly orderKey: string | null;
  readonly beneficiaryUserId: string | null;
  readonly role: 'self' | 'share' | 'direct' | 'indirect' | null;
  /** Trusted caller context, including R14 REASSIGN_REV; never inferred from uniqKey. */
  readonly voucherKind: string | null;
  readonly entries: readonly PostingEntry[];
}

export interface BalanceSelection {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export interface AccountBalance {
  readonly app_id: string;
  readonly account_id: string;
  readonly user_id: string;
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
  readonly version: bigint;
  /** +08:00 accounting date, YYYY-MM-DD, or null. */
  readonly negative_since: string | null;
}

export interface PostingResult {
  readonly kind: 'posted' | 'duplicate';
  readonly voucherId: string;
}

export interface Ledger {
  openUserAccount(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly userId: string },
  ): Promise<AccountBalance>;
  /** Caller locks users first. This method locks only balance rows, in account_id order. */
  lockBalances(trx: Transaction<DB>, input: BalanceSelection): Promise<readonly AccountBalance[]>;
  /** Requires this transaction's balance locks; never opens or commits another transaction. */
  post(trx: Transaction<DB>, voucher: PostingVoucher): Promise<PostingResult>;
  getBalances(db: Kysely<DB>, input: BalanceSelection): Promise<readonly AccountBalance[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: readonly (string | null)[] = ['self', 'share', 'direct', 'indirect', null];
const INCOME_TYPES: readonly (string | null)[] = ['SERVICE_FEE', 'INCIDENTAL', null];
const REASSIGN_REV = 'REASSIGN_REV';

/**
 * Balance rows each open transaction locked through lockBalances, by transaction object.
 * Module-wide (not per ledger instance): a lock belongs to the transaction, whichever ledger
 * instance took it. A different transaction object never inherits another one's locks.
 */
const heldLocks = new WeakMap<Transaction<DB>, Set<string>>();

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_INPUT', `${name} must be a nonempty string`);
  }
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  if (value === null) return null;
  return text(value, name);
}

function userIdList(input: BalanceSelection): string[] {
  if (!Array.isArray(input.userIds)) {
    throw new LedgerError('INVALID_INPUT', 'userIds must be an array');
  }
  const ids: readonly unknown[] = input.userIds;
  return [...new Set(ids.map((id) => text(id, 'userId')))];
}

function toBalance(row: BalanceRow): AccountBalance {
  return {
    app_id: row.app_id,
    account_id: row.account_id,
    user_id: row.user_id,
    available_fen: row.available_fen,
    frozen_fen: row.frozen_fen,
    version: row.version,
    negative_since: row.negative_since,
  };
}

interface PreparedEntry {
  readonly source: PostingEntry;
  /** Domain projection for validateVoucher / applyEntries. */
  readonly domain: LedgerEntry;
  /** User account id, or undefined for a platform subject. */
  readonly userAccountId: string | undefined;
  readonly platformSubject: string | undefined;
}

/**
 * Projects the entries for @couli/domain. User entries are USER_BALANCE with their storage
 * sub-account; platform entries carry their subject with sub_account null (stored as available),
 * so a platform 'frozen' entry or a platform USER_BALANCE subject is refused by validateVoucher.
 */
function prepareEntries(entries: unknown): PreparedEntry[] {
  if (!Array.isArray(entries)) throw new LedgerError('INVALID_INPUT', 'entries must be an array');
  const list: readonly unknown[] = entries;
  return list.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new LedgerError('INVALID_INPUT', `entry ${index} must be an object`);
    }
    const entry = raw as PostingEntry;
    text(entry.ledger_type, 'ledger_type');
    nullableText(entry.sub_type, 'sub_type');
    if (!INCOME_TYPES.includes(entry.income_type)) {
      throw new LedgerError('INVALID_INPUT', `entry ${index} has an unknown income_type`);
    }
    const account: unknown = entry.account;
    if (typeof account !== 'object' || account === null) {
      throw new LedgerError('INVALID_INPUT', `entry ${index} has no account`);
    }
    const ref = account as LedgerAccountRef;
    if (ref.ownerType === 'user') {
      const accountId = text(ref.accountId, 'accountId');
      if (!UUID.test(accountId)) {
        throw new LedgerError('INVALID_INPUT', `entry ${index} account id is not a uuid`);
      }
      const id = accountId.toLowerCase();
      return {
        source: entry,
        domain: {
          account_id: id,
          account_code: USER_SUBJECT,
          sub_account: entry.sub_account,
          amount_fen: entry.amount_fen,
        },
        userAccountId: id,
        platformSubject: undefined,
      };
    }
    if (ref.ownerType === 'platform') {
      const subject = text(ref.subject, 'subject');
      return {
        source: entry,
        domain: {
          account_id: `platform:${subject}`,
          account_code: subject,
          sub_account: entry.sub_account === 'available' ? null : entry.sub_account,
          amount_fen: entry.amount_fen,
        },
        userAccountId: undefined,
        platformSubject: subject,
      };
    }
    throw new LedgerError('INVALID_INPUT', `entry ${index} has an unknown owner type`);
  });
}

function checkVoucherFields(voucher: PostingVoucher): void {
  if (typeof voucher !== 'object' || voucher === null) {
    throw new LedgerError('INVALID_INPUT', 'voucher must be an object');
  }
  text(voucher.appId, 'appId');
  text(voucher.uniqKey, 'uniqKey');
  text(voucher.bizType, 'bizType');
  if (typeof voucher.bizId !== 'string') {
    throw new LedgerError('INVALID_INPUT', 'bizId must be a string');
  }
  text(voucher.operator, 'operator');
  if (voucher.memo !== null && typeof voucher.memo !== 'string') {
    throw new LedgerError('INVALID_INPUT', 'memo must be a string or null');
  }
  nullableText(voucher.orderKey, 'orderKey');
  const beneficiary = nullableText(voucher.beneficiaryUserId, 'beneficiaryUserId');
  if (beneficiary !== null && !UUID.test(beneficiary)) {
    throw new LedgerError('INVALID_INPUT', 'beneficiaryUserId must be a uuid');
  }
  if (!ROLES.includes(voucher.role)) {
    throw new LedgerError('INVALID_INPUT', 'role must be self|share|direct|indirect or null');
  }
  nullableText(voucher.voucherKind, 'voucherKind');
}

/** Distinct (ledger_type, sub_type) pairs, in first-seen order. */
function distinctTypes(entries: readonly PreparedEntry[]): { type: string; sub: string | null }[] {
  const seen = new Map<string, { type: string; sub: string | null }>();
  for (const { source } of entries) {
    const key = JSON.stringify([source.ledger_type, source.sub_type]);
    if (!seen.has(key)) seen.set(key, { type: source.ledger_type, sub: source.sub_type });
  }
  return [...seen.values()];
}

interface AccountWrite {
  readonly before: BalanceRow;
  readonly after: LedgerBalance;
  readonly version: bigint;
  readonly negativeSince: string | null;
}

/**
 * The new balance of one user account: applyEntries (BR-FUND-16, frozen >= 0, int64) then
 * mayGoNegative (BR-FUND-10) for every distinct ledger type that touches this account's
 * available sub-account; all must allow it (fail closed for mixed types).
 */
function computeWrite(
  voucher: PostingVoucher,
  before: BalanceRow,
  entries: readonly PreparedEntry[],
  day: string,
  reversalKind: ReversalKind,
): AccountWrite {
  const own = entries.filter((e) => e.userAccountId === before.account_id);
  let after: LedgerBalance;
  try {
    after = applyEntries(
      {
        account_id: before.account_id,
        available_fen: before.available_fen,
        frozen_fen: before.frozen_fen,
      },
      own.map((e) => e.domain),
    );
  } catch (error) {
    if (error instanceof RangeError) {
      throw new LedgerError('INVALID_BALANCE', `account ${before.account_id}: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
  const delta = subFen(after.available_fen, before.available_fen);
  const touching = own.filter((e) => e.source.sub_account === 'available');
  for (const { type, sub } of distinctTypes(touching)) {
    const input: NegativeBalanceInput = {
      ledger_type: type,
      sub_type: sub,
      uniq_key: voucher.uniqKey,
      resulting_available_fen: after.available_fen,
      available_delta_fen: delta,
      ...(reversalKind === undefined ? {} : { reversal_kind: reversalKind }),
    };
    if (!mayGoNegative(input)) {
      throw new LedgerError(
        'NEGATIVE_BALANCE',
        `account ${before.account_id}: ${type} may not leave available below zero`,
      );
    }
  }
  const negativeSince =
    after.available_fen < 0n
      ? before.available_fen < 0n && before.negative_since !== null
        ? before.negative_since
        : day
      : null;
  return { before, after, version: before.version + 1n, negativeSince };
}

/** Trusted R14 context for mayGoNegative, or undefined (no reassignment exemption). */
type ReversalKind = typeof REASSIGN_REV | undefined;

/**
 * The posting service plus a module-internal entry for ordinary ':REVERSE' corrections
 * (application/reverse.ts). Both share one Clock snapshot per transaction and the lock registry.
 */
export interface PostingCore {
  readonly ledger: Ledger;
  /**
   * post() for a reversal voucher built inside this module. Same checks, savepoint and 23505
   * read-back; the copied voucher_kind never grants the R14 REASSIGN_REV exemption (BR-FUND-10:
   * an ordinary {原 uniq_key}:REVERSE may not leave available below zero).
   */
  postReversal(trx: Transaction<DB>, voucher: PostingVoucher): Promise<PostingResult>;
}

export function createPostingCore(input: { readonly clock: Clock }): PostingCore {
  const { clock } = input;
  /** D2: the Clock is read once per transaction; its vouchers share booked_at and the day. */
  const instants = new WeakMap<Transaction<DB>, Date>();

  function instantOf(trx: Transaction<DB>): Date {
    let at = instants.get(trx);
    if (at === undefined) {
      at = clock.now();
      instants.set(trx, at);
    }
    return at;
  }

  async function write(
    trx: Transaction<DB>,
    voucher: PostingVoucher,
    entries: readonly PreparedEntry[],
    reversalKind: ReversalKind,
  ): Promise<PostingResult> {
    const appId = voucher.appId;
    const userAccountIds = [
      ...new Set(entries.flatMap((e) => (e.userAccountId === undefined ? [] : [e.userAccountId]))),
    ].sort();
    // App scope first, then this transaction's locks (S2: a foreign account is unknown here).
    const known = await userAccountsOfApp(trx, appId, userAccountIds);
    for (const id of userAccountIds) {
      if (!known.has(id)) {
        throw new LedgerError('UNKNOWN_ACCOUNT', `account ${id} is not a user account of the app`);
      }
    }
    const held = heldLocks.get(trx);
    for (const id of userAccountIds) {
      if (held?.has(id) !== true) {
        throw new LedgerError('NOT_LOCKED', `account ${id} was not locked by this transaction`);
      }
    }
    const existing = await findVoucherId(trx, appId, voucher.uniqKey);
    if (existing !== undefined) return { kind: 'duplicate', voucherId: existing };

    const at = instantOf(trx);
    const day = accountingDate(at);
    const rows = await relockHeldBalances(trx, appId, userAccountIds);
    if (rows.length !== userAccountIds.length) {
      throw new LedgerError('UNKNOWN_ACCOUNT', 'a user account has no balance row');
    }
    const writes = new Map(
      rows.map((row) => [row.account_id, computeWrite(voucher, row, entries, day, reversalKind)]),
    );

    const voucherId = randomUUID();
    await insertVoucher(trx, {
      id: voucherId,
      app_id: appId,
      biz_type: voucher.bizType,
      biz_id: voucher.bizId,
      uniq_key: voucher.uniqKey,
      accounting_date: day,
      operator: voucher.operator,
      memo: voucher.memo,
      order_key: voucher.orderKey,
      beneficiary_user_id: voucher.beneficiaryUserId,
      role: voucher.role,
      voucher_kind: voucher.voucherKind,
    });
    const subjects = [
      ...new Set(
        entries.flatMap((e) => (e.platformSubject === undefined ? [] : [e.platformSubject])),
      ),
    ];
    const platform = await ensurePlatformAccounts(trx, appId, subjects);
    const lines: EntryInsert[] = entries.map(({ source, userAccountId, platformSubject }) => {
      const target = userAccountId === undefined ? undefined : writes.get(userAccountId);
      const accountId =
        userAccountId ??
        (platformSubject === undefined ? undefined : platform.get(platformSubject));
      if (accountId === undefined) throw new Error('ledger: entry without an account');
      return {
        app_id: appId,
        voucher_id: voucherId,
        account_id: accountId,
        sub_account: source.sub_account,
        amount_fen: source.amount_fen,
        ledger_type: source.ledger_type,
        sub_type: source.sub_type,
        income_type: source.income_type,
        // D11: the account's state after this voucher, per sub-account, and its new version.
        balance_after_fen:
          target === undefined
            ? null
            : source.sub_account === 'available'
              ? target.after.available_fen
              : target.after.frozen_fen,
        account_version: target === undefined ? null : target.version,
        booked_at: at,
      };
    });
    await insertEntries(trx, lines);
    for (const change of writes.values()) {
      const written = await updateBalance(trx, appId, {
        account_id: change.before.account_id,
        expected_version: change.before.version,
        available_fen: change.after.available_fen,
        frozen_fen: change.after.frozen_fen,
        version: change.version,
        negative_since: change.negativeSince,
      });
      if (!written) {
        throw new LedgerError('BALANCE_CONFLICT', `account ${change.before.account_id} changed`);
      }
    }
    return { kind: 'posted', voucherId };
  }

  async function postChecked(
    trx: Transaction<DB>,
    voucher: PostingVoucher,
    reversalKind: (v: PostingVoucher) => ReversalKind,
  ): Promise<PostingResult> {
    checkVoucherFields(voucher);
    const entries = prepareEntries(voucher.entries);
    const validation = validateVoucher(entries.map((e) => e.domain));
    if (!validation.ok) {
      const codes = [...new Set(validation.errors.map((e) => e.code))].join(',');
      throw new LedgerError('INVALID_VOUCHER', `voucher ${voucher.uniqKey} refused: ${codes}`);
    }
    try {
      return await inSavepoint(trx, () => write(trx, voucher, entries, reversalKind(voucher)));
    } catch (error) {
      // A concurrent writer committed the same (app_id, uniq_key) first: the savepoint undid
      // this attempt, so return the stored voucher and leave the caller's transaction usable.
      if (isUniqKeyViolation(error)) {
        const existing = await findVoucherId(trx, voucher.appId, voucher.uniqKey);
        if (existing !== undefined) return { kind: 'duplicate', voucherId: existing };
      }
      throw error;
    }
  }

  const ledger: Ledger = {
    async openUserAccount(trx, account) {
      const appId = text(account.appId, 'appId');
      const userId = text(account.userId, 'userId');
      return inSavepoint(trx, async () => {
        await ensureUserAccount(trx, appId, userId);
        const [row] = await readBalancesByUser(trx, appId, [userId]);
        if (row === undefined) throw new Error('ledger: user account was not created');
        return toBalance(row);
      });
    },

    async lockBalances(trx, selection) {
      const appId = text(selection.appId, 'appId');
      const rows = await lockBalancesByUser(trx, appId, userIdList(selection));
      let held = heldLocks.get(trx);
      if (held === undefined) {
        held = new Set();
        heldLocks.set(trx, held);
      }
      for (const row of rows) held.add(row.account_id);
      return rows.map(toBalance);
    },

    async post(trx, voucher) {
      // Trusted caller context only (never inferred from uniqKey); read after the field checks.
      return postChecked(trx, voucher, (v) =>
        v.voucherKind === REASSIGN_REV ? REASSIGN_REV : undefined,
      );
    },

    async getBalances(db, selection) {
      const appId = text(selection.appId, 'appId');
      const rows = await readBalancesByUser(db, appId, userIdList(selection));
      return rows.map(toBalance);
    },
  };

  return {
    ledger,
    postReversal: (trx, voucher) => postChecked(trx, voucher, () => undefined),
  };
}
