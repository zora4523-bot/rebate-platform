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
  type RequestCheck,
  type RootLogger,
  type WorkerEntry,
  clockFromConfig,
  createRootLogger,
  installRequestChecks,
  loadConfig,
  resolveTraceId,
} from './modules/platform/index.ts';

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
 * The request checks of REQUEST_CHECKS are installed (before body parsing) on every HTTP entry.
 */
export async function createHttpApp(
  entry: HttpEntry,
  overrides: BootstrapOverrides = {},
): Promise<NestFastifyApplication> {
  try {
    const options = platformOptions(entry, overrides);
    const adapter = new PlatformFastifyAdapter({
      loggerInstance: options.logger,
      genReqId: (request: IncomingMessage) => resolveTraceId(request.headers['x-trace-id']),
    });
    adapter.getInstance().setValidatorCompiler(createValidatorCompiler());
    // Cover every HTTP entry, including errors and responses without an envelope/body.
    adapter.getInstance().addHook('onSend', (request, reply, payload, done) => {
      reply.header('X-Trace-Id', request.id);
      done(null, payload);
    });
    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule.forEntry(options),
      adapter,
      {
        logger: new PinoNestLogger(options.logger),
        abortOnError: false,
      },
    );
    // The only global filter: every error of a request ends in the contract ErrorEnvelope (or, for
    // an uncertain commit, a closed connection); see platform/http/global-errors.ts.
    app.useGlobalFilters(new GlobalErrorFilter(app.getHttpAdapter(), options.logger));
    // The pre-parsing registration point (platform/http/request-checks.ts): the request checks of
    // BR-ID-01 ① (signature) and later ② ③ run in the order app.module lists them, before Fastify
    // parses or validates a body. Installed before init, so it covers every route Nest registers.
    installRequestChecks(adapter.getInstance(), app.get<readonly RequestCheck[]>(REQUEST_CHECKS));
    return app;
  } catch (error) {
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
