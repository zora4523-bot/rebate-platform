// identity's admin user list / lookup / detail (F1-07b) and reveal (F1-07a; BR-ID-33).
// app.module imports this module on the admin entry only; the api and stream entries do not
// serve /admin/v1. Permission and step-up checks go through platform's AdminOperationGuard,
// which the admin module provides on the admin entry (identity never imports admin); the audit
// row goes through platform's AUDIT_PORT, provided globally by the admin module.
// Without a database or field cipher (isolated HTTP unit tests) the route still registers and
// every reveal fails closed (50001).
// The console's edit of member information (B1-27b; BR-ID-44 细则, BR-ID-39 细则「后台改昵称」):
// app.module hands in, as for RiskAdminModule.forAdmin, admin's audit writer bound to the save's
// transaction, identity's revocation by user with the push token unbinding, and risk's blocklist;
// the nickname review is identity's own review of the environment. Without a database or field
// cipher the route still registers and every save fails closed (50001).
// The real-name correction (B1-27a; BR-ID-25 细则「实名更正」): app.module also hands in payout's
// withdrawal readers, a read-only id_no blocklist match over risk's digests and the token of the
// isolated store's own field cipher (PRIOR_IDENTITY_FIELD_CRYPTO); the two-element vendor is
// createRealnameVerifier of the environment, assembled while the entry starts. Without a database,
// field cipher, prior identity cipher or event bus the route still registers and every submission
// fails closed (50001).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  APP_CONFIG,
  AUDIT_PORT,
  CLOCK,
  DB,
  EVENT_BUS,
  FIELD_CRYPTO,
  ROOT_LOGGER,
  type AppConfig,
  type AuditPort,
  type Clock,
  type EventBus,
  type FieldCrypto,
  type RootLogger,
} from '../platform/index.ts';
import {
  AdminProfileEdit,
  type AdminProfileEditOptions,
} from './application/admin-profile-edit.ts';
import { AdminUserProfileController } from './http/admin/user-profile.controller.ts';
import {
  AdminRealnameCorrection,
  type AdminRealnameCorrectionOptions,
} from './application/admin-realname-correction.ts';
import { AdminUserRealnameController } from './http/admin/user-realname.controller.ts';
import { createRealnameVerifier } from './infra/fake-realname-verifier.ts';
import { createNicknameReview } from './infra/nickname-review.ts';
import { AdminUserReveal, type AdminRevealStore } from './application/admin-user-reveal.ts';
import { AdminUserRevealController } from './http/admin/user-reveal.controller.ts';
import { createKyselyAdminRevealStore } from './infra/admin-user-reads.ts';
import { AdminUsers } from './application/admin-users.ts';
import { AdminUsersController } from './http/admin/users.controller.ts';
import { createKyselyAdminUsersReader } from './infra/admin-user-view-reader.ts';

const NO_DATABASE: AdminRevealStore = {
  phoneCipher: () => Promise.reject(new Error('identity: user reveal needs the database')),
};

export interface IdentityAdminOptions {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
  /** identity's revocation of every session of the user, with the push token unbinding. */
  readonly revokeSessions: (clock: Clock) => AdminProfileEditOptions['revokeSessions'];
  /** risk's blocklist over the entry's database (only matchRegistration is used). */
  readonly blocklist: (deps: {
    readonly db: Kysely<Database>;
    readonly clock: Clock;
    readonly crypto: FieldCrypto;
    readonly logger: RootLogger;
  }) => AdminProfileEditOptions['blocklist'];
  /** payout's readers of the user's withdrawals (hasNonTerminal, hasSucceeded). */
  readonly withdrawals: (clock: Clock) => AdminRealnameCorrectionOptions['withdrawals'];
  /** risk's id_no blocklist, read only (a console refusal records no risk_hits). */
  readonly idNoBlocklist: (deps: {
    readonly clock: Clock;
    readonly crypto: FieldCrypto;
  }) => AdminRealnameCorrectionOptions['blocklist'];
  /** The Nest token of the isolated store's own field cipher (PRIOR_IDENTITY_FIELD_CRYPTO). */
  readonly priorIdentityCrypto: symbol;
}

/** Stands in for the service when the entry has no database or field cipher: fails closed. */
const NO_PROFILE_EDIT = {
  edit: () => Promise.reject(new Error('identity: member edits need the database')),
} as unknown as AdminProfileEdit;

/** Stands in for the correction when the entry lacks one of its dependencies: fails closed. */
const NO_REALNAME_CORRECTION = {
  correct: () => Promise.reject(new Error('identity: real-name corrections need the database')),
} as unknown as AdminRealnameCorrection;

@Module({})
export class IdentityAdminModule {
  static forAdmin(options: IdentityAdminOptions): DynamicModule {
    return {
      module: IdentityAdminModule,
      controllers: [
        AdminUserRevealController,
        AdminUsersController,
        AdminUserProfileController,
        AdminUserRealnameController,
      ],
      providers: [
        {
          provide: AdminRealnameCorrection,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            APP_CONFIG,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
            { token: options.priorIdentityCrypto, optional: true },
            { token: EVENT_BUS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            config: AppConfig,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
            priorCrypto?: FieldCrypto,
            events?: EventBus,
          ): AdminRealnameCorrection => {
            // BR-ID-25: the fake two-element verifier in local / test; none in staging / prod yet.
            const verifier = createRealnameVerifier(config.appEnv);
            if (verifier === null) logger.warn({}, 'admin_realname_verifier_unconfigured');
            return db === undefined ||
              crypto === undefined ||
              priorCrypto === undefined ||
              events === undefined
              ? NO_REALNAME_CORRECTION
              : new AdminRealnameCorrection({
                  db,
                  clock,
                  logger,
                  crypto,
                  priorCrypto,
                  verifier,
                  withdrawals: options.withdrawals(clock),
                  blocklist: options.idNoBlocklist({ clock, crypto }),
                  auditOn: (handle: Kysely<Database>) => options.auditWriter(handle, clock),
                  events,
                });
          },
        },
        {
          provide: AdminProfileEdit,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            APP_CONFIG,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            config: AppConfig,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
          ): AdminProfileEdit =>
            db === undefined || crypto === undefined
              ? NO_PROFILE_EDIT
              : new AdminProfileEdit({
                  db,
                  clock,
                  logger,
                  crypto,
                  review: createNicknameReview(config.appEnv),
                  blocklist: options.blocklist({ db, clock, crypto, logger }),
                  auditOn: (trx: Transaction<Database>) => options.auditWriter(trx, clock),
                  revokeSessions: options.revokeSessions(clock),
                }),
        },
        {
          provide: AdminUsers,
          inject: [
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (db?: Kysely<Database>, crypto?: FieldCrypto): AdminUsers =>
            new AdminUsers(
              db === undefined ? null : createKyselyAdminUsersReader(db, crypto ?? null),
              crypto ?? null,
            ),
        },
        {
          provide: AdminUserReveal,
          inject: [
            AUDIT_PORT,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            audit: AuditPort,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
          ): AdminUserReveal =>
            new AdminUserReveal({
              store: db === undefined ? NO_DATABASE : createKyselyAdminRevealStore(db),
              crypto: crypto ?? null,
              audit,
            }),
        },
      ],
    };
  }
}
