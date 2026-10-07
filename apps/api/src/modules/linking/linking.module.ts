import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Kysely } from 'kysely';
import {
  SourceLinkReader,
  createCatalogCardEntry,
  type CardRebateQuoter,
  type ItemRefService,
  type ViewerContext,
} from '../catalog/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  IDEMPOTENCY,
  REDIS,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type RedisHandle,
  type RootLogger,
  type VerifiedDevice,
} from '../platform/index.ts';
import {
  createUnionPidService,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionPidService,
} from '../union/index.ts';
import { LinkOpenService, type LinkOpenInput } from './application/link-open.ts';
import { createLinkOpenPrices } from './application/link-open-prices.ts';
import { createLinkOpenFlights, type LinkOpenFlights } from './application/link-open-requote.ts';
// Through the module namespace, so the composition is observable where it is built.
import {
  createWiredLinkOpen,
  type LinkOpenApps,
  type LinkOpenEnvironment,
  type LinkOpenQuoteReads,
} from './application/link-open-wiring.ts';
import {
  LINK_JUMP_REDIS_NAMESPACE,
  NO_JUMP_CACHE,
  createRedisJumpCache,
  type LinkJumpCache,
} from './infra/jump-cache.ts';
import {
  createLinkRegistration,
  createSourceLinkReader,
  type LinkRegistration,
  type RegistrationContext,
} from './application/link-registration.ts';
import {
  LinkLandingService,
  createLandingLinks,
  createLinkLanding,
  createSnapshotCardReader,
} from './application/link-landing.ts';
import { LinkLandingController } from './http/public/landing.controller.ts';
import { LinkOpenController } from './http/public/open.controller.ts';
import {
  AttrCodeReader,
  CallerContext,
  LinkingConfigReader,
  createGuestCallerContext,
  createUnavailableAttrCodeReader,
  type Caller,
} from './ports.ts';

/** Builds the configuration port; app.module.ts passes content's reader (F1-02b). */
export type LinkingConfigReaderFactory = (
  db: Kysely<Database>,
  clock: Clock,
) => LinkingConfigReader;

/** Per-request factory of card registrations: the scene belongs to the calling use case. */
export interface LinkRegistrations {
  forContext(context: RegistrationContext): LinkRegistration;
}

/** Nest injection tokens provided by `LinkingModule`. */
export const LINK_REGISTRATIONS = Symbol('LINK_REGISTRATIONS');
export const LINKING_PIDS = Symbol('LINKING_PIDS');
/** The open's ports outside linking, provided by app.module.ts (B1-06w). */
export const LINK_OPEN_PORTS = Symbol('LINK_OPEN_PORTS');
/** Process-wide open state: the shared single-flight windows and the Redis jump cache. */
const LINK_OPEN_PROCESS = Symbol('LINK_OPEN_PROCESS');

/**
 * B1-06w: what the open needs from other modules, assembled by the composition root so linking
 * imports neither the union registry nor catalog's providers. None of them may take a database
 * connection while the open holds its transaction (B1-06m): the union adapters call HTTP, the
 * quoter's configuration is pre-read through quoteReads, the item_ref issuer only encrypts.
 */
export interface LinkOpenPorts {
  /** The process's governed union adapters (one per platform, B1-05j). */
  readonly union: { adapter(platform: RegisteredPlatform): UnionAdapter };
  /** The quoter of catalog's card entry (the demo quoter until B2-03). */
  readonly quoter: CardRebateQuoter;
  readonly itemRefs: Pick<ItemRefService, 'issue'>;
  readonly quoteReads: LinkOpenQuoteReads;
  /** contracts/apps.json as read when the entry started. */
  readonly apps: LinkOpenApps;
  /** Jump paths verified per platform and client (CAP-JD-11 / CAP-PDD-11). */
  readonly verifiedPaths: LinkOpenEnvironment['verifiedPaths'];
}

interface LinkOpenProcess {
  readonly flights: LinkOpenFlights;
  readonly cache: LinkJumpCache;
}

type PidReader = Pick<UnionPidService, 'getActivePid'>;

function unavailable(): Promise<never> {
  return Promise.reject(new Error('linking: no database handle in this process'));
}

/** Entries built without database handles (isolated HTTP unit tests) fail at call time. */
const UNAVAILABLE_CONFIG: LinkingConfigReader = { configValue: unavailable };
const UNAVAILABLE_SOURCES: SourceLinkReader = { entrySource: unavailable };
const UNAVAILABLE_PIDS: PidReader = { getActivePid: unavailable };

/** A request without an app scope has no caller at all: every read of it fails closed. */
class UnscopedCallerContext extends CallerContext {
  current(): Promise<Caller> {
    return Promise.reject(new Error('linking: request carries no app scope'));
  }
}

interface ScopedRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  /** Set by the signature check (request-checks stage ①) once the device's signature verified. */
  readonly verifiedDevice?: VerifiedDevice;
}

/**
 * The read-only active-pid query of union (B1-19b). linking only reads, so the union service is
 * built with a verifier and an audit writer that refuse: no admin write can run through it.
 */
function pidReader(db: Kysely<Database>, clock: Clock): PidReader {
  const service = createUnionPidService({
    db,
    clock,
    superVerifier: { verify: () => Promise.resolve(null) },
    auditWriter: () => ({
      append: () => Promise.reject(new Error('linking: union pid writes are not served here')),
    }),
  });
  return { getActivePid: (input) => service.getActivePid(input) };
}

/**
 * The open use case of a process without its ports (no database, idempotency or LINK_OPEN_PORTS:
 * isolated HTTP unit tests): every open fails closed with 50301 (conversion paused) — no cache,
 * no conversion, no link written.
 */
class PausedLinkOpen extends LinkOpenService {
  override open(input: LinkOpenInput): Promise<HandlerResult> {
    return Promise.resolve({
      status: 503,
      envelope: {
        code: 50301,
        msg: '该平台暂时无法购买，请稍后再试',
        trace_id: input.traceId,
      },
    });
  }
}

/**
 * Linking (规划/02 §4.1), B1-06c: card-time link registration (catalog's LinkRegistrar) and the
 * read-only entry_source of a link (catalog's SourceLinkReader). Ports:
 * - CallerContext: a guest of the request's app (X-App-Id) and of the device its signature
 *   verified (none when unsigned), until identity replaces it (B1-02m);
 * - AttrCodeReader: unavailable until identity replaces it (B1-02m); never a user_id fallback;
 * - LinkingConfigReader: built once per process by the factory app.module.ts passes (content).
 * B1-06w: POST /v1/links/{link_id}/open is served by the wired open (link-open-wiring.ts), built
 * per request from LINK_OPEN_PORTS (app.module.ts: governed union, quoter, item_ref issuer,
 * apps.json, verified jump paths), the process's Redis jump cache and single-flight windows.
 * B1-06j: GET /v1/links/{link_id} (link landing card) reads only: no registration, no link_log,
 * no conversion.
 */
@Module({})
export class LinkingModule {
  static forRoot(configReader: LinkingConfigReaderFactory): DynamicModule {
    return {
      module: LinkingModule,
      controllers: [LinkOpenController, LinkLandingController],
      providers: [
        {
          provide: LINK_OPEN_PROCESS,
          inject: [CLOCK, ROOT_LOGGER, { token: REDIS, optional: true }],
          useFactory: (clock: Clock, logger: RootLogger, redis?: RedisHandle): LinkOpenProcess => ({
            flights: createLinkOpenFlights(),
            cache:
              redis === undefined
                ? NO_JUMP_CACHE
                : createRedisJumpCache(redis.namespace(LINK_JUMP_REDIS_NAMESPACE), clock, logger),
          }),
        },
        {
          // Per request, like its CallerContext; the flights and the cache are the process's.
          provide: LinkOpenService,
          scope: Scope.REQUEST,
          inject: [
            { token: DB, optional: true },
            { token: IDEMPOTENCY, optional: true },
            { token: LINK_OPEN_PORTS, optional: true },
            LINK_OPEN_PROCESS,
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            CallerContext,
            AttrCodeReader,
            LinkingConfigReader,
            LINKING_PIDS,
            SourceLinkReader,
          ],
          useFactory: (
            db: Kysely<Database> | undefined,
            idempotency: Idempotency | undefined,
            ports: LinkOpenPorts | undefined,
            process: LinkOpenProcess,
            appConfig: AppConfig,
            clock: Clock,
            logger: RootLogger,
            callerContext: CallerContext,
            attrCodes: AttrCodeReader,
            config: LinkingConfigReader,
            pids: PidReader,
            sourceLinks: SourceLinkReader,
          ): LinkOpenService => {
            if (db === undefined || idempotency === undefined || ports === undefined) {
              return new PausedLinkOpen();
            }
            // The card's viewer is the opener; inside the open the registrar only reserves the
            // renewed snapshot with the opened link's identity (openRegistrationScope).
            const viewerContext: ViewerContext = {
              current: async () => {
                const caller = await callerContext.current();
                return { appId: caller.appId, userId: caller.userId, deviceId: caller.deviceId };
              },
            };
            const registrar = createLinkRegistration({
              db,
              clock,
              callerContext,
              attrCodes,
              config,
              pids,
              context: { scene: 'search' },
            });
            return createWiredLinkOpen({
              db,
              clock,
              callerContext,
              attrCodes,
              config,
              pids,
              catalog: createCatalogCardEntry({
                clock,
                viewerContext,
                quoter: ports.quoter,
                registrar,
                sourceLinks,
                itemRefs: ports.itemRefs,
                logger,
              }),
              prices: createLinkOpenPrices({ clock, union: ports.union }),
              cache: process.cache,
              idempotency,
              flights: process.flights,
              registry: { get: (platform) => ports.union.adapter(platform) },
              logger,
              quoteReads: ports.quoteReads,
              environment: {
                appEnv: appConfig.appEnv,
                apps: ports.apps,
                verifiedPaths: ports.verifiedPaths,
              },
            });
          },
        },
        {
          // B1-06j: the landing card, per request like its CallerContext. Read-only: the links
          // row in the caller's app scope and a card from its quote snapshot (item_ref issuer of
          // LINK_OPEN_PORTS; no union call, no registration, no link_log).
          provide: LinkLandingService,
          scope: Scope.REQUEST,
          inject: [
            { token: DB, optional: true },
            { token: LINK_OPEN_PORTS, optional: true },
            CLOCK,
            CallerContext,
          ],
          useFactory: (
            db: Kysely<Database> | undefined,
            ports: LinkOpenPorts | undefined,
            clock: Clock,
            callerContext: CallerContext,
          ): LinkLandingService =>
            createLinkLanding({
              callerContext,
              links: db === undefined ? { find: unavailable } : createLandingLinks(db),
              cards:
                ports === undefined
                  ? { read: unavailable }
                  : createSnapshotCardReader({ clock, itemRefs: ports.itemRefs }),
            }),
        },
        {
          provide: LinkingConfigReader,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): LinkingConfigReader =>
            db === undefined ? UNAVAILABLE_CONFIG : configReader(db, clock),
        },
        { provide: AttrCodeReader, useFactory: createUnavailableAttrCodeReader },
        {
          provide: LINKING_PIDS,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): PidReader =>
            db === undefined ? UNAVAILABLE_PIDS : pidReader(db, clock),
        },
        {
          provide: SourceLinkReader,
          inject: [{ token: DB, optional: true }],
          useFactory: (db: Kysely<Database> | undefined): SourceLinkReader =>
            db === undefined ? UNAVAILABLE_SOURCES : createSourceLinkReader(db),
        },
        {
          provide: CallerContext,
          scope: Scope.REQUEST,
          inject: [REQUEST],
          useFactory: (request: ScopedRequest): CallerContext => {
            const appId = request.headers?.['x-app-id'];
            if (typeof appId !== 'string' || appId === '') return new UnscopedCallerContext();
            // B1-06w: the guest's device is the one the signature check verified for this app
            // (the open's idempotency subject); an unverified X-Device-Id is never trusted.
            const device = request.verifiedDevice;
            const deviceId =
              device !== undefined && device.appId === appId ? device.deviceId : null;
            return createGuestCallerContext({ appId, deviceId });
          },
        },
        {
          provide: LINK_REGISTRATIONS,
          scope: Scope.REQUEST,
          inject: [
            { token: DB, optional: true },
            CLOCK,
            CallerContext,
            AttrCodeReader,
            LinkingConfigReader,
            LINKING_PIDS,
          ],
          useFactory: (
            db: Kysely<Database> | undefined,
            clock: Clock,
            callerContext: CallerContext,
            attrCodes: AttrCodeReader,
            config: LinkingConfigReader,
            pids: PidReader,
          ): LinkRegistrations => ({
            forContext(context: RegistrationContext): LinkRegistration {
              if (db === undefined) return { register: unavailable, entrySource: unavailable };
              return createLinkRegistration({
                db,
                clock,
                callerContext,
                attrCodes,
                config,
                pids,
                context,
              });
            },
          }),
        },
      ],
      exports: [LINK_REGISTRATIONS, SourceLinkReader, CallerContext, LinkingConfigReader],
    };
  }
}
