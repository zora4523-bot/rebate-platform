// The binding channels' call into the invite reward qualification (task B1-35 §9.2 第 3 条; 08
// BR-INV-24 ①). register / backfill (invite-binder.ts) and landing (landing-binder.ts) call it
// after the relation change log, in the binding's own transaction, with the bind's single instant.
// The call runs under its own SAVEPOINT: whatever the qualifier does wrong (a failed statement, a
// thrown error) is rolled back to it and logged at error level with app and user ids and the error
// class only, and the binding still succeeds. The qualifier is optional (unit and older rule tests
// assemble the binders without one): no qualifier, nothing happens.
//
// Self-contained on purpose (structural types only): invite-reward.ts imports invite-binder.ts's
// types, and the binders import this file, so no import cycle forms.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';

/** The binding facts a qualification locks (structurally InviteRewardQualificationInput). */
export interface InviteRewardBindFacts {
  readonly app_id: string;
  readonly invitee_id: string;
  readonly inviter_id: string;
  readonly bind_source: 'register' | 'backfill' | 'landing';
  /** The binding request's client IP; never stored or logged in clear. */
  readonly client_ip: string;
  readonly at: Date;
}

/** Structurally growth's InviteRewardQualifier (invite-reward.ts). */
export interface InviteRewardQualifierPort {
  qualifyInviteReward(trx: Transaction<DB>, input: InviteRewardBindFacts): Promise<void>;
}

interface ErrorLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

const BIND_SAVEPOINT = sql.raw('growth_invite_reward_bind');

function errorClassOf(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return error === null ? 'null' : typeof error;
}

/** Runs the qualification after a successful bind; never rejects for the qualifier's own faults. */
export async function qualifyAfterBind(
  qualifier: InviteRewardQualifierPort | undefined,
  logger: ErrorLogger,
  trx: Transaction<DB>,
  facts: InviteRewardBindFacts,
): Promise<void> {
  if (qualifier === undefined) return;
  await sql`SAVEPOINT ${BIND_SAVEPOINT}`.execute(trx);
  try {
    await qualifier.qualifyInviteReward(trx, facts);
    await sql`RELEASE SAVEPOINT ${BIND_SAVEPOINT}`.execute(trx);
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT ${BIND_SAVEPOINT}`.execute(trx);
    await sql`RELEASE SAVEPOINT ${BIND_SAVEPOINT}`.execute(trx);
    logger.error(
      { app_id: facts.app_id, invitee_id: facts.invitee_id, error_class: errorClassOf(error) },
      'invite_reward_qualify_failed',
    );
  }
}
