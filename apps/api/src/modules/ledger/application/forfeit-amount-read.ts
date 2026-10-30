// B1-03z (D10-432): read-only port of the amount a share's FORFEIT voucher booked to the platform
// (BR-CALC-13: `{order_key}:PLATFORM:FORFEIT:{uid}:{role}`, the same key for the first credit R5 and
// a deferred share turned forfeited R5a), for risk's appeal restore differences (BR-FUND-22 ③,
// BR-CALC-13 细则「申诉恢复」). One SELECT on the caller's handle: no write, lock, transaction,
// clock or log. The key is built by @couli/domain uniqKey (PLATFORM_FORFEIT, no reassign id).
//
// Amount = − Σ amount_fen (debit positive, credit negative) of that voucher's entries on the
// platform COMMISSION_REVENUE account (a dimension suffix `COMMISSION_REVENUE:…` counts too, as in
// order-nets.ts). null when the app has no voucher under that key; 0 when it has one without a
// COMMISSION_REVENUE entry.
import type { DB } from '@couli/db';
import { uniqKey, type LedgerRole } from '@couli/domain';
import { subFen } from '@couli/money';
import type { Kysely } from 'kysely';
import { LedgerError } from './errors.ts';

export interface ForfeitAmountSelection {
  readonly appId: string;
  readonly orderKey: string;
  readonly userId: string;
  readonly role: string;
}

const ROLES: readonly string[] = ['self', 'share', 'direct', 'indirect'];
const SUBJECT = 'COMMISSION_REVENUE';

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_INPUT', `${name} must be a nonempty string`);
  }
  return value;
}

function forfeitKey(input: ForfeitAmountSelection): string {
  if (!ROLES.includes(input.role)) {
    throw new LedgerError('INVALID_INPUT', 'role is not a beneficiary role');
  }
  try {
    return uniqKey({
      kind: 'PLATFORM_FORFEIT',
      order_key: text(input.orderKey, 'orderKey'),
      user_id: text(input.userId, 'userId'),
      role: input.role as LedgerRole,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new LedgerError('INVALID_INPUT', `cannot build the FORFEIT key: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** What the share's FORFEIT voucher credited to COMMISSION_REVENUE, in fen; null: no voucher. */
export async function readForfeitAmount(
  db: Kysely<DB>,
  input: ForfeitAmountSelection,
): Promise<bigint | null> {
  if (typeof input !== 'object' || input === null) {
    throw new LedgerError('INVALID_INPUT', 'input must be an object');
  }
  const appId = text(input.appId, 'appId');
  const key = forfeitKey(input);
  const rows = await db
    .withSchema('app')
    .selectFrom('ledger_vouchers as v')
    .leftJoin('ledger_entries as e', (join) =>
      join.onRef('e.app_id', '=', 'v.app_id').onRef('e.voucher_id', '=', 'v.id'),
    )
    .leftJoin('ledger_accounts as a', (join) =>
      join.onRef('a.app_id', '=', 'e.app_id').onRef('a.id', '=', 'e.account_id'),
    )
    .select(['v.id as voucher_id', 'e.amount_fen', 'a.owner_type', 'a.subject'])
    .where('v.app_id', '=', appId)
    .where('v.uniq_key', '=', key)
    .execute();
  if (rows.length === 0) return null;
  let amount = 0n;
  for (const row of rows) {
    if (
      row.amount_fen !== null &&
      row.owner_type === 'platform' &&
      row.subject !== null &&
      (row.subject === SUBJECT || row.subject.startsWith(`${SUBJECT}:`))
    ) {
      amount = subFen(amount, row.amount_fen);
    }
  }
  return amount;
}
