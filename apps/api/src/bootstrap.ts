// Builds the Nest application for a process entry. Nothing here listens on a port: the entry
// files decide whether to listen, and tests drive HTTP entries through Fastify `inject`.
import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.ts';
import {
  GlobalErrorFilter,
  PlatformFastifyAdapter,
} from './modules/platform/http/global-errors.ts';
import { createValidatorCompiler } from './modules/platform/validation/index.ts';
import {
  type AppConfig,
  type Clock,
  type ConnectionConfig,
  type DbHandles,
  type EntryName,
  type HttpEntry,
  PinoNestLogger,
  type PlatformOptions,
  REQUEST_CHECKS,
  type RequestCheckPlan,
  type RootLogger,
  type WorkerEntry,
  clockFromConfig,
  contractAuthOf,
  createRootLogger,
  installAdminCors,
  installRequestChecks,
  isContractSignedRoute,
  loadConfig,
  refuseRoutes,
  resolveTraceId,
} from './modules/platform/index.ts';
import { ADMIN_HTTP_POLICY, isAdminCheck, type AdminHttpPolicy } from './modules/admin/index.ts';
import { isTokenCheck } from './modules/identity/index.ts';
import { isSignatureCheck } from './modules/risk/index.ts';

export interface BootstrapOverrides {
  /** Process-owned handles; omitted when building isolated HTTP unit tests. */
  readonly dbHandles?: DbHandles;
  /** Defaults to `loadConfig(process.env)`. */
  readonly config?: AppConfig;
  /** Defaults to `clockFromConfig(config)`. */
  readonly clock?: Clock;
  /** Defaults to a pino root logger on stdout at `config.logLevel`. */
  readonly logger?: RootLogger;
  /**
   * The entry's validated REDIS_URL (`ConnectionConfig.redisUrl`): the platform module provides
   * a lazy `REDIS` handle and closes it on shutdown. Null (payout) or omitted: no `REDIS`.
   */
  readonly redisUrl?: ConnectionConfig['redisUrl'];
}

function platformOptions(entry: EntryName, overrides: BootstrapOverrides): PlatformOptions {
  const config = overrides.config ?? loadConfig(process.env);
  return {
    entry,
    config,
    ...(overrides.dbHandles === undefined ? {} : { dbHandles: overrides.dbHandles }),
    ...(overrides.redisUrl === undefined ? {} : { redisUrl: overrides.redisUrl }),
    clock: overrides.clock ?? clockFromConfig(config),
    logger:
      overrides.logger ??
      createRootLogger({ level: config.logLevel, entry, appEnv: config.appEnv }),
  };
}

/**
 * Creates an HTTP entry (NestJS on the Fastify adapter) and returns it WITHOUT calling
 * `init()` or `listen()`. Fastify logs through the same pino instance as the application, and
 * the Fastify request id is the trace id (well-formed `x-trace-id` header or a random UUID).
 * The request check plan of REQUEST_CHECKS is installed (before body parsing) on every HTTP entry;
 * a plan whose signature check is not its first check, or whose token check comes before its
 * signature check, is refused (the entry does not start); a contract x-signed route that the
 * plan's signature check does not cover, a contract route that needs an app token (x-auth
 * optional / login / phone / realname) on an entry whose plan has no token check, and a contract
 * route at an admin level (x-auth admin / super) on an entry whose plan has no admin check (api
 * and stream), cannot be registered (the entry does not start). The admin entry also answers the
 * console's CORS requests (exact origin only, F1-06k).
 */
export async function createHttpApp(
  entry: HttpEntry,
  overrides: BootstrapOverrides = {},
): Promise<NestFastifyApplication> {
  let app: NestFastifyApplication | undefined;
  try {
    const options = platformOptions(entry, overrides);
    // Client IP (B1-03m): only the configured gateways' X-Forwarded-For entries are believed, so
    // `request.ip` is the rightmost untrusted address; with none configured (or a hand-built
    // config without the field) it stays the socket address. Every consumer reads `request.ip`.
    const trustedProxies = options.config.trustedProxies ?? [];
    const adapter = new PlatformFastifyAdapter({
      loggerInstance: options.logger,
      genReqId: (request: IncomingMessage) => resolveTraceId(request.headers['x-trace-id']),
      ...(trustedProxies.length === 0 ? {} : { trustProxy: [...trustedProxies] }),
    });
    adapter.getInstance().setValidatorCompiler(createValidatorCompiler());
    // Cover every HTTP entry, including errors and responses without an envelope/body.
    adapter.getInstance().addHook('onSend', (request, reply, payload, done) => {
      reply.header('X-Trace-Id', request.id);
      done(null, payload);
    });
    app = await NestFactory.create<NestFastifyApplication>(AppModule.forEntry(options), adapter, {
      logger: new PinoNestLogger(options.logger),
      abortOnError: false,
    });
    // The only global filter: every error of a request ends in the contract ErrorEnvelope (or, for
    // an uncertain commit, a closed connection); see platform/http/global-errors.ts.
    app.useGlobalFilters(new GlobalErrorFilter(app.getHttpAdapter(), options.logger));
    // The pre-parsing registration point (platform/http/request-checks.ts): the request checks of
    // BR-ID-01 ① (signature) and ② ③ (token) run in the order app.module lists them, on every
    // matched route (bodies buffered where the plan's bufferWhen says), before Fastify parses or
    // validates a body. Installed before init, so it covers every route Nest registers.
    const plan = app.get<RequestCheckPlan>(REQUEST_CHECKS);
    const server = adapter.getInstance();
    // ② ③ come after ① (BR-ID-01 判定顺序): a token check placed before a signature check would
    // answer a signed request with 10001 / 10002 / 10403 before its signature (and run ③ without
    // the verified device), so the entry does not start.
    const firstToken = plan.checks.findIndex(isTokenCheck);
    if (firstToken !== -1 && plan.checks.slice(firstToken).some(isSignatureCheck)) {
      throw new Error(
        `the ${entry} entry's request check plan must run the token check (BR-ID-01 ②) after the request signature check (BR-ID-01 ①)`,
      );
    }
    // ① comes first (BR-ID-01 判定顺序): a plan holding the signature check anywhere else would
    // answer a signed request from a later stage (and run ③ without the verified device) before
    // its signature, so the entry does not start.
    const signs = isSignatureCheck(plan.checks[0]);
    if (!signs && plan.checks.some(isSignatureCheck)) {
      throw new Error(
        `the ${entry} entry's request check plan must run the request signature check (BR-ID-01 ①) first`,
      );
    }
    // Every contract x-signed route this entry registers must reach stage ① (BR-ID-09): refused
    // at registration when the plan has no signature check (stream and admin today) or does not
    // buffer the route. Nest registers its routes in init, which then rejects.
    const buffered = plan.bufferWhen;
    refuseRoutes(
      server,
      (method, template) =>
        isContractSignedRoute(method, template) &&
        !(signs && (buffered === undefined || buffered(method, template))),
      `the ${entry} entry does not run the request signature check (BR-ID-09 ①) on this contract x-signed route`,
    );
    // A contract route at an admin level (x-auth admin / super, admin_auth_level) needs the admin
    // token check (F1-06k), which only the admin entry's plan runs: refused at registration on
    // the other entries (registered before the refusal below, so this is the reason given).
    const adminChecked = plan.checks.some(isAdminCheck);
    const adminLevel = (method: string, template: string): boolean => {
      const auth = contractAuthOf(method, template);
      return auth === 'admin' || auth === 'super';
    };
    if (!adminChecked) {
      refuseRoutes(
        server,
        adminLevel,
        `the ${entry} entry does not run the admin token check (admin_auth_level); it refuses this contract admin route`,
      );
    }
    // Every contract route that takes an app token (x-auth optional / login / phone / realname)
    // must reach stages ② ③ (BR-ID-01): refused at registration when the plan has no token check
    // (stream and admin), so such a route never serves a request no token was checked on.
    // Routes outside the contract (undefined), x-auth none and, where the admin check runs, the
    // admin levels register as before.
    if (firstToken === -1) {
      refuseRoutes(
        server,
        (method, template) => {
          const auth = contractAuthOf(method, template);
          if (adminChecked && adminLevel(method, template)) return false;
          return auth !== undefined && auth !== 'none';
        },
        `the ${entry} entry does not run the token check (BR-ID-01 ②) on this contract route that takes a token`,
      );
    }
    // The console's CORS (02 §3.4): before the checks, so a preflight is answered by origin.
    if (entry === 'admin') {
      installAdminCors(server, app.get<AdminHttpPolicy>(ADMIN_HTTP_POLICY));
    }
    installRequestChecks(server, plan.checks, plan.bufferWhen);
    return app;
  } catch (error) {
    // Raised after NestFactory.create (installing the plan): close the application so its
    // providers shut down. Its close error is dropped: the original error is the one to report.
    // The database handles are closed again below (idempotent) for errors raised before the app.
    await app?.close().catch(() => undefined);
    await overrides.dbHandles?.close();
    throw error;
  }
}

/**
 * Creates a non-HTTP entry (worker, payout) as an initialised Nest application context.
 */
export async function createWorkerContext(
  entry: WorkerEntry,
  overrides: BootstrapOverrides = {},
): Promise<INestApplicationContext> {
  try {
    const options = platformOptions(entry, overrides);
    return await NestFactory.createApplicationContext(AppModule.forEntry(options), {
      logger: new PinoNestLogger(options.logger),
      abortOnError: false,
    });
  } catch (error) {
    await overrides.dbHandles?.close();
    throw error;
  }
}
