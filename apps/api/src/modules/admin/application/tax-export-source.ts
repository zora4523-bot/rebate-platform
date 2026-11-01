// The rows of a quarterly tax export (规划/08 BR-WDR-21; contract adminCreateExport, File; task
// B2-08e): one page of payout's read-only port (B2-08d) joined with identity's batch real names.
// The full version writes the ID number as it is, the masked one its first 6 and last 4; the payee
// account is masked in both, by payout. A withdrawal whose real name cannot be read refuses the page
// (TaxRealnameUnreadableError, no value in it): the file never goes out with a hole in it.
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { RealnameExportBatchReader } from '../../identity/index.ts';
import type { TaxExportRead } from '../../payout/index.ts';
import { maskTaxIdNo, shanghaiInstant } from '../domain/tax-export.ts';

/** The two ports, assembled by app.module (no empty stand-in on the worker entry). */
export interface TaxExportPorts {
  readonly withdrawals: TaxExportRead;
  readonly realnames: RealnameExportBatchReader;
}

/** A real name that is missing or does not decrypt; deliberately without any detail. */
export class TaxRealnameUnreadableError extends Error {
  constructor() {
    super('tax export: a real name could not be read');
    this.name = 'TaxRealnameUnreadableError';
  }
}

export interface TaxExportPageInput {
  readonly appId: string;
  readonly quarter: string;
  readonly masked: boolean;
  readonly cursor: string | undefined;
  readonly limit: number;
}

export interface TaxExportCells {
  readonly rows: readonly (readonly (string | null)[])[];
  readonly nextCursor: string | null;
}

export async function readTaxExportPage(
  ports: TaxExportPorts,
  handle: Kysely<DB>,
  input: TaxExportPageInput,
): Promise<TaxExportCells> {
  const { appId, quarter, masked, cursor, limit } = input;
  const page = await ports.withdrawals(handle, {
    appId,
    quarter,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  });
  let identities: Awaited<ReturnType<RealnameExportBatchReader['read']>>;
  try {
    identities = await ports.realnames.read(handle, {
      appId,
      userIds: page.items.map((item) => item.user_id),
    });
  } catch {
    // The cause is dropped on purpose: nothing of a decrypted or undecryptable value goes on.
    throw new TaxRealnameUnreadableError();
  }
  const rows = page.items.map((item) => {
    const identity = identities.get(item.user_id);
    if (identity === undefined) throw new TaxRealnameUnreadableError();
    const corrected = identity.correctedAfter(item.paid_at);
    return [
      identity.name,
      masked ? maskTaxIdNo(identity.id_no) : identity.id_no,
      item.income_type,
      String(item.amount_fen),
      String(item.tax_fen),
      shanghaiInstant(item.paid_at),
      item.masked_account,
      item.out_biz_no,
      corrected === null ? null : shanghaiInstant(corrected),
    ];
  });
  return { rows, nextCursor: page.next_cursor };
}
