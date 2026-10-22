// B2-05f: the member's own withdrawal records (规划/04 §6.4 listWithdrawals / getWithdrawal; 08
// BR-TEXT-06 状态与收款账号的展示, BR-WDR-25 展示判定, BR-WDR-08 状态). One projection serves the HTTP
// list, the HTTP detail and the read-only entry `read.ts` (BR-AI-02 ④ / D32), so the two paths are
// field-for-field equal. Only the row's own snapshot is projected: the payee name, cipher and
// HMAC fixed at creation, never the member's current payout account. The cipher is decrypted in
// memory through a port the process composition registers once (app.module, the field cipher of
// the process) and masked before it crosses this boundary; the cleartext is never logged,
// stored or returned. Paging: (created_at DESC, id DESC), cursor = base64url(created_at ISO +
// ':' + id), limit default 20 and at most 50 (contract Limit). Read-only: no writes, no logging.
//
// Also compiled by the `test` project: erasable syntax only.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber } from '@couli/money';
import { sql, type Kysely, type Selectable } from 'kysely';
import { isAccountFailure, payoutChannelName } from '../domain/display.ts';
import { maskPayeeAccount } from '../domain/mask-payee.ts';

/** Only snapshot fields; current identity/payout-account data is never a projection input. */
export type WithdrawalRecordRow = Pick<
  Selectable<DB['withdrawals']>,
  | 'id'
  | 'status'
  | 'review_mode'
  | 'amount_fen'
  | 'fee_fen'
  | 'tax_fen'
  | 'net_fen'
  | 'payout_method'
  | 'payout_channel'
  | 'payee_account_cipher'
  | 'reject_reason_code'
  | 'fail_code'
  | 'created_at'
  | 'channel_order_id'
>;

/** In-memory decryption port; the cleartext must be masked before crossing the read boundary. */
export type DecryptWithdrawalAccount = (cipher: Buffer, method: string) => string;

export interface WithdrawalListQuery {
  readonly appId: string;
  readonly userId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WithdrawalPage {
  readonly items: Schema<'WithdrawalSummary'>[];
  readonly next_cursor: string | null;
}

/** A refused query parameter (the contract rejects most of them before the handler; 20001). */
export class WithdrawalReadError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`withdrawal read: invalid ${fields.join(', ')}`);
    this.name = 'WithdrawalReadError';
    this.fields = fields;
  }
}

const RECORD_COLUMNS = [
  'id',
  'status',
  'review_mode',
  'amount_fen',
  'fee_fen',
  'tax_fen',
  'net_fen',
  'payout_method',
  'payout_channel',
  'payee_account_cipher',
  'reject_reason_code',
  'fail_code',
  'created_at',
  'channel_order_id',
] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const PAID: readonly string[] = ['PAID_API', 'PAID_MANUAL'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** +08:00 (China Standard Time, no daylight saving); the contract's created_at carries it. */
const OFFSET_MS = 8 * 3_600_000;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYY-MM-DDTHH:mm:ss.sss+08:00` of `at` (no wall clock, no `new Date`). */
export function chinaIso(at: Date): string {
  const shifted = structuredClone(at);
  shifted.setTime(at.getTime() + OFFSET_MS);
  return (
    `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `.${pad(shifted.getUTCMilliseconds(), 3)}+08:00`
  );
}

function channelOf(value: string): 'alipay' | 'bank_card' | 'wechat' {
  if (value === 'alipay' || value === 'bank_card' || value === 'wechat') return value;
  throw new Error('payout: unknown payout channel on a withdrawal row');
}

function methodOf(value: string): 'alipay' | 'bank_card' | 'wechat' {
  if (value === 'alipay' || value === 'bank_card' || value === 'wechat') return value;
  throw new Error('payout: unknown payout method on a withdrawal row');
}

export function projectWithdrawalSummary(
  row: WithdrawalRecordRow,
  decryptAccount: DecryptWithdrawalAccount,
): Schema<'WithdrawalSummary'> {
  const method = methodOf(row.payout_method);
  const channel = channelOf(row.payout_channel);
  const failed = row.status === 'FAILED';
  const reason = row.status === 'REJECTED' ? row.reject_reason_code : failed ? row.fail_code : null;
  return {
    withdrawal_id: row.id,
    status: row.status as Schema<'WithdrawalStatus'>,
    review_mode: row.review_mode as Schema<'WithdrawalSummary'>['review_mode'],
    amount_fen: fenToJsonNumber(row.amount_fen),
    fee_fen: fenToJsonNumber(row.fee_fen),
    tax_fen: fenToJsonNumber(row.tax_fen),
    net_fen: fenToJsonNumber(row.net_fen),
    payout_channel: channel as Schema<'WithdrawalSummary'>['payout_channel'],
    payout_channel_name: payoutChannelName(channel),
    masked_account: maskPayeeAccount(method, decryptAccount(row.payee_account_cipher, method)),
    reason_code: reason,
    fail_action: failed && isAccountFailure(row.fail_code) ? 'change_payout_account' : null,
    created_at: chinaIso(row.created_at),
  };
}

export function projectWithdrawalDetail(
  row: WithdrawalRecordRow,
  decryptAccount: DecryptWithdrawalAccount,
): Schema<'Withdrawal'> {
  return {
    ...projectWithdrawalSummary(row, decryptAccount),
    channel_order_id: PAID.includes(row.status) ? row.channel_order_id : null,
  };
}

// ---- cursor -------------------------------------------------------------------------------------

interface CursorPosition {
  /** The row's created_at as an ISO instant; compared in PostgreSQL as timestamptz. */
  readonly createdAt: string;
  readonly id: string;
}

export function encodeWithdrawalCursor(position: CursorPosition): string {
  return Buffer.from(`${position.createdAt}:${position.id}`, 'utf8').toString('base64url');
}

/** The position a cursor names, or null when it is not one of ours (malformed). */
export function decodeWithdrawalCursor(cursor: string): CursorPosition | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const split = text.lastIndexOf(':');
  if (split <= 0) return null;
  const id = text.slice(split + 1);
  const createdAt = text.slice(0, split);
  if (!UUID.test(id) || !Number.isFinite(Date.parse(createdAt))) return null;
  return { createdAt, id };
}

// ---- process composition -----------------------------------------------------------------------

let registeredDecrypt: DecryptWithdrawalAccount | null = null;

/**
 * The process registers its field cipher once (app.module); the read-only entry has no other way
 * to decrypt the snapshot for masking. Idempotent; the HTTP controllers use the same port.
 */
export function registerWithdrawalAccountDecrypt(decrypt: DecryptWithdrawalAccount): void {
  registeredDecrypt = decrypt;
}

function currentDecrypt(): DecryptWithdrawalAccount {
  if (registeredDecrypt === null) {
    throw new Error('payout: withdrawal reads need the field cipher registered by app.module');
  }
  return registeredDecrypt;
}

// ---- reads --------------------------------------------------------------------------------------

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new WithdrawalReadError(['limit']);
  }
  return limit;
}

/** Process composition supplies decryption; public callers supply only the subject and paging.
 * Order: created_at DESC, id DESC. Cursor: base64url(created_at ISO + ':' + id).
 */
export async function listWithdrawalsForUser(
  db: Kysely<DB>,
  query: WithdrawalListQuery,
): Promise<WithdrawalPage> {
  const decrypt = currentDecrypt();
  const limit = pageSize(query.limit);
  let select = db
    .withSchema('app')
    .selectFrom('withdrawals')
    .select(RECORD_COLUMNS)
    .where('app_id', '=', query.appId)
    .where('user_id', '=', query.userId);
  if (query.cursor !== undefined) {
    const position = decodeWithdrawalCursor(query.cursor);
    if (position === null) throw new WithdrawalReadError(['cursor']);
    const at = sql<Date>`${position.createdAt}::timestamptz`;
    select = select.where((eb) =>
      eb.or([
        eb('created_at', '<', at),
        eb.and([eb('created_at', '=', at), eb('id', '<', position.id)]),
      ]),
    );
  }
  const rows = await select
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => projectWithdrawalSummary(row, decrypt)),
    next_cursor:
      rows.length > limit && last !== undefined
        ? encodeWithdrawalCursor({ createdAt: last.created_at.toISOString(), id: last.id })
        : null,
  };
}

/** One of the member's own withdrawals as the contract's detail, or null (someone else's, unknown). */
export async function readWithdrawalForUser(
  db: Kysely<DB>,
  query: { readonly appId: string; readonly userId: string; readonly withdrawalId: string },
): Promise<Schema<'Withdrawal'> | null> {
  const decrypt = currentDecrypt();
  if (!UUID.test(query.withdrawalId)) return null;
  const row = await db
    .withSchema('app')
    .selectFrom('withdrawals')
    .select(RECORD_COLUMNS)
    .where('app_id', '=', query.appId)
    .where('user_id', '=', query.userId)
    .where('id', '=', query.withdrawalId)
    .executeTakeFirst();
  return row === undefined ? null : projectWithdrawalDetail(row, decrypt);
}
