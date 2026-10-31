// B2-04q r3 (D10-317): version-independent read of one sub-order's attribution — the reserve ratio
// and the beneficiaries with their ratios from the immutable commission_splits row (BR-CALC-10),
// plus the state of each share (BR-CALC-13, D10-481 ②). Unlike readCommissionSnapshot it reads no amount
// version: callers that take amounts elsewhere (R5a uses booked_base_fen / booked_n_fen) must not
// fail because orders.commission_version moved ahead of the stored amount rows.
// SELECT only, inside the caller's transaction; no SQL clock; a missing snapshot throws.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import {
  parseSnapshotBeneficiaries,
  type SnapshotForfeitedEvent,
} from '../domain/snapshot-read.ts';
import { selectSplit } from '../infra/snapshot-reader.ts';
import { readShareStates, type ShareStateBeneficiary } from './forfeited-state-read.ts';

export interface ReadCommissionAttributionInput {
  readonly appId: string;
  readonly orderId: string;
}

export interface ReadCommissionAttributionResult {
  readonly appId: string;
  readonly orderId: string;
  readonly ruleVersionId: string;
  readonly reserveBp: number;
  /** D10-481 ②: initialStatus stays the snapshot's; forfeitLifted marks one no longer forfeited. */
  readonly beneficiaries: readonly ShareStateBeneficiary[];
  /** The latest event of each share of this app's sub-order still forfeited, event_seq ascending. */
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
  const shares = await readShareStates(trx, appId, orderId, beneficiaries);
  return {
    appId,
    orderId,
    ruleVersionId: split.ruleVersionId,
    reserveBp: split.reserveBp,
    ...shares,
  };
}
