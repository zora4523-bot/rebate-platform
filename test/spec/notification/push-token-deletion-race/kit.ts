// F1-02zzl (ruling D10-318; 08 BR-ID-28 注销 processing 阶段删除推送 token, BR-ID-30 推送令牌
// 「注销时删除」; brief §9.2 / §9.3): fixture of the push token report × deletion cleanup race.
// The report under test is notification's createPushTokenReporter (the B1-12c kit's fixture). The
// cleanup side is the way identity's cleanup runs notification's port: one transaction that locks
// the users row FOR UPDATE, may move users.status, and calls deletePushTokensForUser (through
// notification/index.ts). Interleavings are pinned with held transactions, the B1-12c barrier gates
// and lock-wait polling (no sleeps). No rule of the report lives here.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  deletePushTokensForUser,
  type PushTokenReport,
} from '../../../../apps/api/src/modules/notification/index.ts';
import { PROVIDER, type Actor, type Fixture } from '../push-token-report/kit.ts';

export {
  DB_TIMEOUT,
  PROVIDER,
  closeSuite,
  expectNoTokenText,
  fixture,
  mark,
  openSuite,
  ownRow,
  type Actor,
  type Fixture,
  type Suite,
} from '../push-token-report/kit.ts';
export { gateAfter, mentionsTable, track, waitBlocked } from '../push-token-report/barrier.ts';

/** The users.status values of an account being deleted or deleted (04 §3.2 note, BR-ID-27). */
export type GoneStatus = 'deleting' | 'deleted';

// ---- the report's settlement, as plain data ---------------------------------------------------

export type Settlement =
  { readonly status: 'resolved' } | { readonly status: 'rejected'; readonly code: string };

/**
 * How a report promise settled. A rejection becomes data (the error's SQLSTATE code or its name),
 * so a report that rejects fails the test's assertion rather than surfacing the database error.
 */
export async function settle(promise: Promise<void>): Promise<Settlement> {
  try {
    await promise;
    return { status: 'resolved' };
  } catch (error) {
    const shape = (typeof error === 'object' && error !== null ? error : {}) as Record<
      string,
      unknown
    >;
    const code = shape['code'] ?? shape['name'];
    return { status: 'rejected', code: typeof code === 'string' ? code : 'unknown' };
  }
}

export const RESOLVED: Settlement = { status: 'resolved' };

// ---- reading and committed setup --------------------------------------------------------------

/** Every push_tokens row of the fixture's app carrying `userId`. */
export function tokensOfUser(f: Fixture, userId: string) {
  return f.db
    .selectFrom('push_tokens')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('user_id', '=', userId)
    .orderBy('id')
    .execute();
}

/** users.status of (app, user). */
export async function statusOf(f: Fixture, userId: string): Promise<string | undefined> {
  const { rows } = await sql<{ status: string }>`SELECT status FROM app.users
    WHERE app_id = ${f.appId} AND id = ${userId}`.execute(f.db);
  return rows[0]?.status;
}

/** Commits a users.status change on its own (e.g. the deletion request already moved it). */
export async function setStatus(
  f: Fixture,
  userId: string,
  status: GoneStatus | 'normal',
  reason: string | null = null,
): Promise<void> {
  await f.db.transaction().execute((trx) => moveStatus(trx, f.appId, userId, status, reason));
}

/** A report command of `actor` with every field explicit (for subjects the kit cannot log in). */
export function command(f: Fixture, actor: Actor, token: string): PushTokenReport {
  return {
    app_id: f.appId,
    user_id: actor.user_id,
    sid: actor.sid,
    device_id: actor.device_id,
    provider: PROVIDER,
    token,
  };
}

// ---- the cleanup side (statements identity's cleanup transaction runs) ------------------------

/** The users row lock identity's cleanup takes before calling the ports. */
export async function lockUserForUpdate(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<void> {
  await sql`SELECT id FROM app.users WHERE app_id = ${appId} AND id = ${userId}
    FOR UPDATE`.execute(trx);
}

/** A device row lock taken after the users row (lock order users → devices). */
export async function lockDeviceForUpdate(
  trx: Transaction<DB>,
  appId: string,
  deviceId: string,
): Promise<void> {
  await sql`SELECT id FROM app.devices WHERE app_id = ${appId} AND id = ${deviceId}
    FOR UPDATE`.execute(trx);
}

/** users.status change inside the caller's transaction (deleting, or the deleted tombstone). */
export async function moveStatus(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
  status: GoneStatus | 'normal',
  reason: string | null = null,
): Promise<void> {
  await sql`UPDATE app.users
    SET status = ${status}, deleted_reason = ${reason}, row_version = row_version + 1
    WHERE app_id = ${appId} AND id = ${userId}`.execute(trx);
}

/** notification's deletion cleanup port, on the caller's transaction; returns the rows deleted. */
export async function cleanTokens(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
  at: Date,
): Promise<number> {
  const result = await deletePushTokensForUser(trx, { appId, userId, at });
  return result.deleted;
}

// ---- a transaction the test drives step by step -----------------------------------------------

export interface Held {
  /** Runs `work` on the held transaction; settles once it ran (its lock waits included). */
  run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T>;
  /** Commits; resolves once committed. */
  commit(): Promise<void>;
  /** Rolls back unless already ended; never rejects (for `finally`). */
  abandon(): Promise<void>;
}

const ABANDONED = new Error('held transaction rolled back by the rule test');

/** Opens a transaction on `db` that stays open, idle in transaction, between the test's steps. */
export function hold(db: Kysely<DB>): Held {
  type Step = ((trx: Transaction<DB>) => Promise<void>) | 'commit' | 'rollback';
  const steps: Step[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const push = (step: Step): void => {
    steps.push(step);
    const resume = wake;
    wake = undefined;
    resume?.();
  };
  const next = async (): Promise<Step> => {
    while (steps.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return steps.shift()!;
  };
  const done = db.transaction().execute(async (trx) => {
    for (;;) {
      const step = await next();
      if (step === 'commit') return;
      if (step === 'rollback') throw ABANDONED;
      await step(trx);
    }
  });
  const finished = done.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );
  return {
    run: <T>(work: (trx: Transaction<DB>) => Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        if (ended) {
          reject(new Error('held transaction already ended'));
          return;
        }
        push(async (trx) => {
          try {
            resolve(await work(trx));
          } catch (error) {
            reject(error);
            throw error;
          }
        });
      }),
    commit: async () => {
      push('commit');
      await done;
    },
    abandon: async () => {
      if (!ended) push('rollback');
      await finished;
    },
  };
}
