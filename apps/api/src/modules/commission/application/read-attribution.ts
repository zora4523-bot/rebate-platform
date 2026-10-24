// B2-04q r3 (D10-317): version-independent read of one sub-order's attribution — the reserve ratio
// and the beneficiaries with their ratios from the immutable commission_splits row (BR-CALC-10),
// plus every forfeited event (BR-CALC-13). Unlike readCommissionSnapshot it reads no amount
// version: callers that take amounts elsewhere (R5a uses booked_base_fen / booked_n_fen) must not
// fail because orders.commission_version moved ahead of the stored amount rows.
// SELECT only, inside the caller's transaction; no SQL clock; a missing snapshot throws.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import {
  parseSnapshotBeneficiaries,
  parseSnapshotRole,
  type ReadSnapshotBeneficiary,
  type SnapshotForfeitedEvent,
} from '../domain/snapshot-read.ts';
import { selectForfeitedEvents, selectSplit } from '../infra/snapshot-reader.ts';

export interface ReadCommissionAttributionInput {
  readonly appId: string;
  readonly orderId: string;
}

export interface ReadCommissionAttributionResult {
  readonly appId: string;
  readonly orderId: string;
  readonly ruleVersionId: string;
  readonly reserveBp: number;
  readonly beneficiaries: readonly ReadSnapshotBeneficiary[];
  /** Every forfeited event of this app's sub-order, event_seq ascending. */
  readonly forfeitedEvents: readonly SnapshotForfeitedEvent[];
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`commission: ${name} must be a nonempty string`);
  }
  return value;
}

/** Throws when the sub-order has no commission_splits row for input.appId (never defaults). */
export async function readCommissionAttribution(
  trx: Transaction<DB>,
  input: ReadCommissionAttributionInput,
): Promise<ReadCommissionAttributionResult> {
  const appId = text(input.appId, 'appId');
  const orderId = text(input.orderId, 'orderId');
  const split = await selectSplit(trx, appId, orderId);
  if (split === undefined) {
    throw new Error('commission: the sub-order has no commission snapshot');
  }
  const beneficiaries = parseSnapshotBeneficiaries(split.beneficiaries);
  const events = await selectForfeitedEvents(trx, appId, orderId);
  return {
    appId,
    orderId,
    ruleVersionId: split.ruleVersionId,
    reserveBp: split.reserveBp,
    beneficiaries,
    forfeitedEvents: events.map((e): SnapshotForfeitedEvent => ({
      eventSeq: e.eventSeq,
      userId: e.userId,
      role: parseSnapshotRole(e.role, `event ${String(e.eventSeq)}`),
      reason: e.reason,
    })),
  };
}
