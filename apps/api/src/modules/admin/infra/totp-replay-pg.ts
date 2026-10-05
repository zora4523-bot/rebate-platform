// Durable TOTP replay store on app.admin_users.totp_last_step (F1-06a round 2). This is the
// production store: it holds across processes and restarts, so two runs of a seed script or
// command-line tool cannot both accept the same code (AGENTS.md §4.4: idempotency ends in PG).
//
// Consuming a claim is one conditional UPDATE:
//   UPDATE app.admin_users SET totp_last_step = :step
//    WHERE app_id = :app AND id = :admin AND (totp_last_step IS NULL OR totp_last_step < :step)
// Exactly one affected row means first use. PG's row lock serialises concurrent consumers: the
// second one re-evaluates the predicate after the first commits and updates nothing.
//
// Time steps are MONOTONIC per account: once a step has been accepted, that step and every
// older step count as used. So after a code of step N is accepted, a code of step N-1 (still
// inside the ±1 window) is refused too. This is stricter than per-step bookkeeping and needs
// only one column.
//
// A missing account (or one in another app) updates nothing and is refused. A database error
// propagates, and the verifier fails closed.
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { TotpClaim, TotpReplayStore } from '../domain/totp.ts';

export function createPgTotpReplayStore(deps: { db: Kysely<DB> }): TotpReplayStore {
  const { db } = deps;
  return {
    async consume(claim: TotpClaim): Promise<boolean> {
      const result = await db
        .updateTable('admin_users')
        .set({ totp_last_step: claim.timeStep })
        .where('app_id', '=', claim.appId)
        .where('id', '=', claim.adminId)
        .where((eb) =>
          eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', claim.timeStep)]),
        )
        .executeTakeFirst();
      return result.numUpdatedRows === 1n;
    },
  };
}
