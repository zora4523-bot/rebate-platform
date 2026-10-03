// Builds the Nest application for a process entry. Nothing here listens on a port: the entry
// files decide whether to listen, and tests drive HTTP entries through Fastify `inject`.
import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import { Catch, type ArgumentsHost, type INestApplicationContext } from '@nestjs/common';
import { BaseExceptionFilter, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.ts';
import {
  createValidatorCompiler,
  validationErrorEnvelope,
} from './modules/platform/validation/index.ts';
import {
  type AppConfig,
  type Clock,
  type EntryName,
  type HttpEntry,
  PinoNestLogger,
  type PlatformOptions,
  type RootLogger,
  type WorkerEntry,
  clockFromConfig,
  createRootLogger,
  loadConfig,
  resolveTraceId,
} from './modules/platform/index.ts';

export interface BootstrapOverrides {
  /** Defaults to `loadConfig(process.env)`. */
  readonly config?: AppConfig;
  /** Defaults to `clockFromConfig(config)`. */
  readonly clock?: Clock;
  /** Defaults to a pino root logger on stdout at `config.logLevel`. */
  readonly logger?: RootLogger;
}

@Catch()
class RequestValidationFilter extends BaseExceptionFilter<unknown> {
  override catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = validationErrorEnvelope(error, http.getRequest<{ id: string }>().id);
    if (response === undefined) {
      super.catch(error, host);
      return;
    }
    this.applicationRef?.reply(http.getResponse(), response.body, response.statusCode);
  }
}

function platformOptions(entry: EntryName, overrides: BootstrapOverrides): PlatformOptions {
  const config = overrides.config ?? loadConfig(process.env);
  return {
    entry,
    config,
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
 */
export async function createHttpApp(
  entry: HttpEntry,
  overrides: BootstrapOverrides = {},
): Promise<NestFastifyApplication> {
  const options = platformOptions(entry, overrides);
  const adapter = new FastifyAdapter({
    loggerInstance: options.logger,
    genReqId: (request: IncomingMessage) => resolveTraceId(request.headers['x-trace-id']),
  });
  adapter.getInstance().setValidatorCompiler(createValidatorCompiler());
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forEntry(options),
    adapter,
    {
      logger: new PinoNestLogger(options.logger),
      abortOnError: false,
    },
  );
  app.useGlobalFilters(new RequestValidationFilter(app.getHttpAdapter()));
  return app;
}

/**
 * Creates a non-HTTP entry (worker, payout) as an initialised Nest application context.
 */
export async function createWorkerContext(
  entry: WorkerEntry,
  overrides: BootstrapOverrides = {},
): Promise<INestApplicationContext> {
  const options = platformOptions(entry, overrides);
  return NestFactory.createApplicationContext(AppModule.forEntry(options), {
    logger: new PinoNestLogger(options.logger),
    abortOnError: false,
  });
}
