// Nest wrapper of the admin module. It provides the platform audit port globally, so any
// module can `@Inject(AUDIT_PORT)` without importing admin (规划/02 §4.1 dependency direction),
// and the durable TOTP replay store (admin_users.totp_last_step) for admin's own later use.
// Login, binding, permissions, step-up and /admin/v1 routes are later tasks.
import { Global, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  AUDIT_PORT,
  CLOCK,
  DB,
  SENSITIVE_KEYS,
  type AuditPort,
  type Clock,
} from '../platform/index.ts';
import type { TotpReplayStore } from './domain/totp.ts';
import { createAuditWriter } from './infra/audit-writer.ts';
import { createPgTotpReplayStore } from './infra/totp-replay-pg.ts';

/** Nest token of admin's TotpReplayStore (admin-internal; the durable PG store). */
export const TOTP_REPLAY_STORE = Symbol('TOTP_REPLAY_STORE');

/** Without a database (isolated HTTP unit tests) the port exists but refuses every write. */
function unavailableAuditPort(): AuditPort {
  return {
    append(): Promise<void> {
      return Promise.reject(new Error('audit port: no database configured for this process'));
    },
  };
}

/** Without a database no code can be consumed: verification fails closed. */
function unavailableReplayStore(): TotpReplayStore {
  return {
    consume(): Promise<boolean> {
      return Promise.reject(
        new Error('totp replay store: no database configured for this process'),
      );
    },
  };
}

@Global()
@Module({
  providers: [
    {
      provide: AUDIT_PORT,
      inject: [CLOCK, { token: DB, optional: true }],
      useFactory: (clock: Clock, db: Kysely<Database> | undefined): AuditPort =>
        db === undefined
          ? unavailableAuditPort()
          : createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
    },
    {
      provide: TOTP_REPLAY_STORE,
      inject: [{ token: DB, optional: true }],
      useFactory: (db: Kysely<Database> | undefined): TotpReplayStore =>
        db === undefined ? unavailableReplayStore() : createPgTotpReplayStore({ db }),
    },
  ],
  exports: [AUDIT_PORT],
})
export class AdminModule {}
