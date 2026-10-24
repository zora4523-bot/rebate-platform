// B1-27j: payout's succeeded-withdrawal reader (D10-137 ②, BR-ID-25 旧身份留存). Only
// *.int.test.ts provisions PG; this kit reuses the B2-05e state helpers and never builds a database.
import { expect } from 'vitest';
import type { WithdrawalSucceededReader } from '../../../../apps/api/src/modules/identity/ports/withdrawal-in-flight.ts';
import type { Clock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createWithdrawalInFlightReader,
  type WithdrawalReaders,
} from '../../../../apps/api/src/modules/payout/application/withdrawal-in-flight.ts';

export {
  close,
  open,
  TIMEOUT,
  setup,
  snapshot,
  seedStatus,
  seedUser,
  type Harness,
} from '../state/kit.ts';

/** Terminal states that count as paid out (db/schema.sql withdrawals_status_check). */
export const PAID = ['PAID_API', 'PAID_MANUAL'] as const;
export const STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'PAYING',
  'REJECTED',
  'PAID_API',
  'PAID_MANUAL',
  'FAILED',
] as const;
export type Status = (typeof STATUSES)[number];

export function isPaid(status: Status): boolean {
  return (PAID as readonly string[]).includes(status);
}

/**
 * The reader app.module wires for identity: createWithdrawalInFlightReader's object must also
 * implement identity's WithdrawalSucceededReader (task §9 technical choice).
 */
export function succeededReader(clock: Clock): WithdrawalReaders & WithdrawalSucceededReader {
  const reader: WithdrawalReaders & Partial<WithdrawalSucceededReader> =
    createWithdrawalInFlightReader({ clock });
  expect(typeof reader.hasSucceeded, 'payout reader exposes hasSucceeded').toBe('function');
  return reader as WithdrawalReaders & WithdrawalSucceededReader;
}
