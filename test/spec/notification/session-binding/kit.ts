// B1-12b: only fixture SQL and explicit composition of existing identity transaction hooks.
// No implementation of the binding predicate lives here. All token mutations under test go
// through notification's public commands. openSuite uses the shared TEST_PG_ADMIN_URL harness.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { TableNode, type Kysely } from 'kysely';
import type { AfterSessionsRevoked } from '../../../../apps/api/src/modules/identity/application/revoke-sessions.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import {
  bindPushTokensForSession,
  unbindPushTokensForSession,
} from '../../../../apps/api/src/modules/notification/index.ts';
import { fixture as sessionFixture, type Suite } from '../../identity/session/kit.ts';
export { openSuite, closeSuite, type Suite } from '../../identity/session/kit.ts';
export { seedUser } from '../../identity/registration/kit.ts';

export async function fixture(suite: Suite) {
  const f = await sessionFixture(suite);
  const seedToken = async (
    overrides: {
      device_id?: string;
      app_id?: string;
      user_id?: string | null;
      bound_sid?: string | null;
      provider?: string;
      frozen_until?: Date | null;
      revoked_at?: Date | null;
    } = {},
  ) => {
    const id = randomUUID();
    await f.db
      .insertInto('push_tokens')
      .values({
        id,
        app_id: f.appId,
        device_id: f.deviceId,
        user_id: f.uid,
        bound_sid: f.initial.sid,
        provider: 'apns',
        token: `fixture-token-${id}`,
        token_set_at: f.clock.now(),
        acquired_by_move_at: null,
        frozen_until: null,
        revoked_at: null,
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
        ...overrides,
      })
      .execute();
    return id;
  };
  const token = (id: string) =>
    f.db.selectFrom('push_tokens').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const login = (uid = f.uid, deviceId = f.deviceId) =>
    f.db.transaction().execute((trx) =>
      createSession(
        trx,
        { uid, app_id: f.appId, device_id: deviceId, scp: 'full' },
        f,
        (sameTransaction, issued) =>
          bindPushTokensForSession(
            sameTransaction,
            {
              app_id: f.appId,
              user_id: uid,
              device_id: deviceId,
              sid: issued.sid,
            },
            f.clock,
          ),
      ),
    );
  const unbind = (user = f.uid, sid = f.initial.sid, app = f.appId) =>
    f.db
      .transaction()
      .execute((trx) =>
        unbindPushTokensForSession(trx, { app_id: app, user_id: user, sid }, f.clock),
      );
  // identity owns sessions. The composition resolves the revoked sids to the command's
  // (app, user, sid); notification receives no permission to read identity's tables.
  const afterRevoked: AfterSessionsRevoked = async (trx, sids) => {
    for (const sid of sids) {
      const session = await trx
        .selectFrom('sessions')
        .select(['user_id', 'sid'])
        .where('app_id', '=', f.appId)
        .where('sid', '=', sid)
        .executeTakeFirstOrThrow();
      await unbindPushTokensForSession(
        trx,
        {
          app_id: f.appId,
          user_id: session.user_id,
          sid: session.sid,
        },
        f.clock,
      );
    }
  };
  return { ...f, seedToken, token, login, unbind, afterRevoked };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Inject an error at the token UPDATE boundary; sessions and rollback still use real PG. */
export function rejectTokenWrites(db: Kysely<DB>) {
  const failure = new Error('fixture push-token write failed');
  let attempts = 0;
  const failingDb = db.withPlugin({
    transformQuery({ node }) {
      if (
        node.kind === 'UpdateQueryNode' &&
        node.table !== undefined &&
        TableNode.is(node.table) &&
        node.table.table.identifier.name === 'push_tokens'
      ) {
        attempts += 1;
        throw failure;
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  return { db: failingDb, failure, attempts: () => attempts };
}
