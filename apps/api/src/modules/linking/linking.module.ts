import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Kysely } from 'kysely';
import { SourceLinkReader } from '../catalog/index.ts';
import { CLOCK, DB, type Clock, type HandlerResult } from '../platform/index.ts';
import { createUnionPidService, type UnionPidService } from '../union/index.ts';
import { LinkOpenService, type LinkOpenInput } from './application/link-open.ts';
import {
  createLinkRegistration,
  createSourceLinkReader,
  type LinkRegistration,
  type RegistrationContext,
} from './application/link-registration.ts';
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
 * The open use case until its ports are composed in this process: every open fails closed with
 * 50301 (conversion paused) — no cache, no conversion, no link written.
 */
// TODO(规划/11 §4.5): open 用例装配（复核取价端口、转链缓存、union 注册表与 catalog 卡片入口） — blocked on app.module.ts 组合根接线。
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
 * - CallerContext: a guest of the request's app (X-App-Id), device unknown, until identity
 *   replaces it (B1-02m);
 * - AttrCodeReader: unavailable until identity replaces it (B1-02m); never a user_id fallback;
 * - LinkingConfigReader: built once per process by the factory app.module.ts passes (content).
 */
@Module({})
export class LinkingModule {
  static forRoot(configReader: LinkingConfigReaderFactory): DynamicModule {
    return {
      module: LinkingModule,
      controllers: [LinkOpenController],
      providers: [
        { provide: LinkOpenService, useFactory: (): LinkOpenService => new PausedLinkOpen() },
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
            return typeof appId === 'string' && appId !== ''
              ? createGuestCallerContext({ appId, deviceId: null })
              : new UnscopedCallerContext();
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
