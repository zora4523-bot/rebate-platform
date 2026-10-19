import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  LedgerError,
  type Ledger,
  type LedgerErrorCode,
  type ReverseInput,
} from '../../../../apps/api/src/modules/ledger/index.ts';

// Reuse the merged posting harness; only *.int.test.ts imports the database provisioner.
export {
  TIMEOUT,
  account,
  bounded,
  close,
  context,
  entry,
  open,
  post,
  snapshot,
  voucher,
  waitBlocked,
  type Harness,
} from '../posting/kit.ts';

export async function reverse(
  db: Kysely<DB>,
  ledger: Ledger,
  userIds: readonly string[],
  input: ReverseInput,
) {
  return db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId: input.appId, userIds });
    return ledger.reverse(trx, input);
  });
}

export async function refused(attempt: Promise<unknown>, code: LedgerErrorCode): Promise<void> {
  await expect(attempt).rejects.toBeInstanceOf(LedgerError);
  await expect(attempt).rejects.toMatchObject({ code });
}

// Sort full semantic tuples, retaining multiplicity; do not assume insertion/SELECT order.
export function tuples(
  lines: readonly {
    account_id: string;
    sub_account: string;
    amount_fen: bigint;
    ledger_type: string;
    sub_type: string | null;
    income_type: string | null;
  }[],
) {
  return lines
    .map((line) =>
      JSON.stringify([
        line.account_id,
        line.sub_account,
        line.amount_fen.toString(),
        line.ledger_type,
        line.sub_type,
        line.income_type,
      ]),
    )
    .sort();
}
