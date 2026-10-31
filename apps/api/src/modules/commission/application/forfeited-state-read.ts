// B2-09ga (编排裁定 D10-481 ②): how commission's two reads answer the state of each share, so that
// settlement's funds paths follow the one judgement (isShareForfeited) without importing it.
//   - forfeitedEvents: the latest event of each share whose latest event is forfeited.
//   - beneficiaries[].forfeitLifted: true on an initially forfeited share the judgement no longer
//     holds forfeited (restored, or held as its latest event). initialStatus stays the snapshot's
//     value (BR-CALC-10) and every other share keeps the parsed object as it is, without the key.
// The events are read a second time only for an initially forfeited share not listed, so an order
// without one costs a single SELECT here. SELECT only, inside the caller's transaction.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import {
  parseSnapshotRole,
  type ReadSnapshotBeneficiary,
  type SnapshotForfeitedEvent,
} from '../domain/snapshot-read.ts';
import {
  selectForfeitedEvents,
  selectShareEvents,
  type StoredShareEvent,
} from '../infra/snapshot-reader.ts';
import { isShareForfeited, type ShareEvent, type ShareEventStatus } from './forfeited-state.ts';

/** A snapshot beneficiary with commission's answer on an initially forfeited share. */
export interface ShareStateBeneficiary extends ReadSnapshotBeneficiary {
  readonly forfeitLifted?: true;
}

export interface ShareStates {
  readonly beneficiaries: readonly ShareStateBeneficiary[];
  readonly forfeitedEvents: readonly SnapshotForfeitedEvent[];
}

function shareEventStatus(stored: StoredShareEvent): ShareEventStatus {
  const { status } = stored;
  if (status === 'active' || status === 'held' || status === 'forfeited') return status;
  throw new TypeError(`commission: event ${String(stored.eventSeq)} has an unknown status`);
}

export async function readShareStates(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  beneficiaries: readonly ReadSnapshotBeneficiary[],
): Promise<ShareStates> {
  const listed = await selectForfeitedEvents(trx, appId, orderId);
  const forfeitedEvents = listed.map((e): SnapshotForfeitedEvent => ({
    eventSeq: e.eventSeq,
    userId: e.userId,
    role: parseSnapshotRole(e.role, `event ${String(e.eventSeq)}`),
    reason: e.reason,
  }));
  const open = beneficiaries.filter(
    (b) =>
      b.initialStatus === 'forfeited' &&
      !forfeitedEvents.some((e) => e.userId === b.userId && e.role === b.role),
  );
  if (open.length === 0) return { beneficiaries, forfeitedEvents };

  const stored = await selectShareEvents(trx, appId, orderId);
  const lifted = new Set(
    open.filter((b) => {
      const events = stored
        .filter((e) => e.userId === b.userId && e.role === b.role)
        .map((e): ShareEvent => ({ eventSeq: e.eventSeq, status: shareEventStatus(e) }));
      return !isShareForfeited(b.initialStatus, events);
    }),
  );
  return {
    beneficiaries: beneficiaries.map((b) => (lifted.has(b) ? { ...b, forfeitLifted: true } : b)),
    forfeitedEvents,
  };
}
