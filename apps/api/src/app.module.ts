import { type DynamicModule, type Provider, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { AdminModule } from './modules/admin/index.ts';
import { CatalogModule } from './modules/catalog/index.ts';
import { createContentReader } from './modules/content/index.ts';
import { HealthModule } from './modules/health/index.ts';
import { IdentityModule, type SmsConfigReader } from './modules/identity/index.ts';
import { LinkingModule } from './modules/linking/index.ts';
import { ParsingModule } from './modules/parsing/index.ts';
import {
  CLOCK,
  DB,
  PlatformModule,
  type Clock,
  type PlatformOptions,
  REQUEST_CHECKS,
  type RequestCheck,
  type RequestCheckPlan,
  isContractSignedRoute,
  isHttpEntry,
} from './modules/platform/index.ts';
import { RiskModule, SIGNATURE_CHECK } from './modules/risk/index.ts';
import { UnionModule } from './modules/union/index.ts';

/**
 * The request check plan bootstrap installs before Fastify parses a body (规划/08 BR-ID-01):
 * on the `api` entry, which serves every x-signed operation, ① the request signature, buffered and
 * run only on the contract x-signed routes (other routes keep Fastify's own body handling); the
 * token stages ② ③ (B1-02h) follow it in this list, and their route scope is settled with them.
 * The other HTTP entries have no check yet, so bootstrap refuses an x-signed route on them.
 */
function requestChecks(options: PlatformOptions): Provider {
  return options.entry === 'api'
    ? {
        provide: REQUEST_CHECKS,
        inject: [SIGNATURE_CHECK],
        useFactory: (signature: RequestCheck): RequestCheckPlan => ({
          checks: [signature],
          bufferWhen: isContractSignedRoute,
        }),
      }
    : { provide: REQUEST_CHECKS, useValue: { checks: [] } satisfies RequestCheckPlan };
}

/**
 * The identity module of the `api` entry. Its configuration port (sms.blocked_prefixes, BR-ID-05)
 * is content's cached reader of config_items: content implements the port's shape without importing
 * identity (same assembly as the risk ports, F1-02b). No database handle (isolated HTTP unit
 * tests): no reader, and the SMS code route answers 50001.
 */
function identityModule(): DynamicModule {
  return IdentityModule.forRoot({
    config: {
      inject: [CLOCK, { token: DB, optional: true }],
      useFactory: (clock: Clock, db?: Kysely<Database>): SmsConfigReader | null =>
        db === undefined ? null : createContentReader({ db, clock }),
    },
  });
}

/**
 * Root module, assembled per process entry. Every HTTP entry serves the health probe; the `api`
 * entry also serves the /v1 identity routes and the risk module's request signature check, whose
 * device port identity implements. The union module (adapter registry and endpoint configuration)
 * loads where union platforms are called: `api` (search, linking) and `worker` (order sync); the
 * other worker entries load only the platform and admin modules.
 * The admin module provides the platform audit port on every entry (F1-06b).
 * The catalog module (platform dictionary, product_refs, aliases, category blocklist) loads on
 * `api`, where search, detail and parsing run; its configuration port is content's reader,
 * assembled here so catalog never imports content (B1-05c).
 * The linking module (card-time link registration, B1-06c) loads on `api` beside catalog; its
 * configuration port is content's reader too, assembled here so linking never imports content.
 * The parsing module (parse_input core, B1-07a) loads on `api` as well; its configuration port
 * (parse.tpwd.enabled, product_key.jd.mode) is content's reader, so parsing never imports content.
 * Business modules are added to the entries that own them by their tasks (规划/02 §4.1).
 */
@Module({})
export class AppModule {
  static forEntry(options: PlatformOptions): DynamicModule {
    // One module object for both imports, so Nest builds the identity module once.
    const identity = options.entry === 'api' ? identityModule() : undefined;
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(options),
        // Provides the platform AUDIT_PORT globally on every entry (F1-06b).
        AdminModule,
        ...(isHttpEntry(options.entry) ? [HealthModule] : []),
        ...(identity === undefined ? [] : [identity, RiskModule.forRoot({ imports: [identity] })]),
        ...(options.entry === 'api' || options.entry === 'worker' ? [UnionModule.forRoot()] : []),
        ...(options.entry === 'api'
          ? [
              CatalogModule.forRoot((db, clock) => createContentReader({ db, clock })),
              LinkingModule.forRoot((db, clock) => createContentReader({ db, clock })),
              ParsingModule.forRoot((db, clock) => createContentReader({ db, clock })),
            ]
          : []),
      ],
      providers: isHttpEntry(options.entry) ? [requestChecks(options)] : [],
    };
  }
}
