// B2-09d: the settlement console's monthly bill reads (CT-24z listAdminSettleBills,
// getAdminSettleBill, listAdminSettleBatchItems; 08 BR-FUND-04 细则「月结账单状态」; 04 §3.2
// settle_bills, settle_batches, settle_batch_items). Read only: the bill status is derived from the
// batches of the bill's latest round at read time and never stored.
//
// NotImplemented skeleton of the rule-test round (test/spec/settlement/admin-settle-bills/).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export type AdminSettleBillStatus = Schema<'AdminSettleBillStatus'>;

/** The settle_batches columns the derived status and the latest round are read from (as stored). */
export interface AdminSettleRoundBatch {
  readonly batch_id: string;
  readonly platform: string;
  readonly kind: string;
  readonly status: string;
  readonly settle_mode: string;
  readonly scheduled_at: Date | null;
  readonly created_at: Date;
}

/** What AdminSettleBillStatus derives for one bill at one instant. */
export interface AdminSettleBillDerivation {
  readonly status: AdminSettleBillStatus;
  /**
   * batch_id of every batch of the bill's latest round, CANCELLED included (the batches whose
   * in_current_round is true); [] when the bill has no batch.
   */
  readonly currentRound: readonly string[];
}

/**
 * AdminSettleBillStatus of a bill: `generatedAt` is settle_bills.generated_at, `batches` every
 * settle_batches row of the bill (any order), `now` the server clock.
 */
export function deriveAdminSettleBill(
  generatedAt: Date | null,
  batches: readonly AdminSettleRoundBatch[],
  now: Date,
): AdminSettleBillDerivation {
  void generatedAt;
  void batches;
  void now;
  throw new Error('NotImplemented: deriveAdminSettleBill');
}

/** What the reads need besides the app (assembled on the admin entry). */
export interface AdminSettleBillReadDeps {
  readonly db: Kysely<DB>;
  /** The response instant (injected Clock): CONFIRMED batches due or not. */
  readonly now: () => Date;
}

export interface AdminSettleBillListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly bill_from?: string;
  readonly bill_to?: string;
  readonly status?: AdminSettleBillStatus;
}

export interface AdminSettleBatchItemListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly item_type?: Schema<'AdminSettleBatchItemType'>;
  readonly result?: Schema<'AdminSettleBatchItemResultFilterValue'>;
}

export function listAdminSettleBills(
  deps: AdminSettleBillReadDeps,
  appId: string,
  query: AdminSettleBillListQuery,
): Promise<Schema<'AdminSettleBillPage'>> {
  void deps;
  void appId;
  void query;
  throw new Error('NotImplemented: listAdminSettleBills');
}

export function getAdminSettleBill(
  deps: AdminSettleBillReadDeps,
  appId: string,
  billId: string,
): Promise<Schema<'AdminSettleBillDetail'>> {
  void deps;
  void appId;
  void billId;
  throw new Error('NotImplemented: getAdminSettleBill');
}

export function listAdminSettleBatchItems(
  deps: AdminSettleBillReadDeps,
  appId: string,
  batchId: string,
  query: AdminSettleBatchItemListQuery,
): Promise<Schema<'AdminSettleBatchItemPage'>> {
  void deps;
  void appId;
  void batchId;
  void query;
  throw new Error('NotImplemented: listAdminSettleBatchItems');
}
