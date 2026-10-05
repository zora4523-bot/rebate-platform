// Shared runner behind the five `main.<entry>.ts` files.
import { createHttpApp, createWorkerContext } from './bootstrap.ts';
import {
  type AppConfig,
  type ConnectionConfig,
  type DbHandles,
  type MaintConnectionConfig,
  type MaintDbHandle,
  ConfigError,
  type EntryName,
  type HttpEntry,
  type RootLogger,
  type QueueRuntime,
  JOB_QUEUE,
  createRootLogger,
  createDbHandles,
  createMaintDbHandle,
  loadMaintConnectionConfig,
  createWorkerMaintenance,
  startWorkerServices,
  clockFromConfig,
  isHttpEntry,
  loadConfig,
  loadConnectionConfig,
} from './modules/platform/index.ts';

// Keeps a worker process alive until a signal arrives; longer than any deployment lives.
const KEEP_ALIVE_INTERVAL_MS = 2 ** 30;

function portOf(entry: HttpEntry, config: AppConfig): number {
  if (entry === 'api') return config.apiPort;
  if (entry === 'stream') return config.streamPort;
  return config.adminPort;
}

/** Closes the process cleanly on the first SIGTERM / SIGINT. */
function closeOnSignal(logger: RootLogger, close: () => Promise<void>): void {
  let closing = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'stopping');
    close().then(
      () => {
        logger.info('stopped');
      },
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown_failed');
        process.exitCode = 1;
      },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

async function start(
  entry: EntryName,
  config: AppConfig,
  logger: RootLogger,
  dbHandles: DbHandles,
  maintHandle: MaintDbHandle | null,
  redisUrl: ConnectionConfig['redisUrl'],
): Promise<void> {
  if (isHttpEntry(entry)) {
    const app = await createHttpApp(entry, { config, logger, dbHandles, redisUrl });
    try {
      await app.init();
      if (config.exitAfterInit) {
        logger.info({ listening: false }, 'started');
        await app.close();
        return;
      }
      await app.get<QueueRuntime>(JOB_QUEUE).start();
      const port = portOf(entry, config);
      await app.listen(port, config.apiHost);
      logger.info({ listening: true, host: config.apiHost, port }, 'started');
      closeOnSignal(logger, () => app.close());
    } catch (error) {
      await app.close();
      throw error;
    }
    return;
  }

  if (entry === 'worker') {
    let stopping = false;
    let services: Awaited<ReturnType<typeof startWorkerServices>> | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const shutdown = async (): Promise<void> => {
      try {
        await services?.stop();
        logger.info('stopped');
      } catch (error) {
        logger.error({ err: error }, 'shutdown_failed');
        process.exitCode = 1;
      } finally {
        clearInterval(keepAlive);
      }
    };
    if (!config.exitAfterInit) {
      const onSignal = (signal: NodeJS.Signals): void => {
        if (stopping) return;
        stopping = true;
        logger.info({ signal }, 'stopping');
        // Startup owns cleanup until it succeeds; never stop a service still starting.
        if (services !== undefined) void shutdown();
      };
      process.on('SIGTERM', onSignal);
      process.on('SIGINT', onSignal);
    }
    const clock = clockFromConfig(config);
    const context = await createWorkerContext(entry, {
      config,
      logger,
      dbHandles,
      clock,
      redisUrl,
    });
    let servicesOwnCleanup = false;
    try {
      if (config.exitAfterInit) {
        logger.info({ listening: false }, 'started');
        return;
      }
      const queue = context.get<QueueRuntime>(JOB_QUEUE);
      const maintenance =
        maintHandle === null
          ? null
          : createWorkerMaintenance({
              db: maintHandle.db,
              logger,
              clock,
            });
      servicesOwnCleanup = true;
      services = await startWorkerServices({
        queue,
        maintenance,
        logger,
        close: [
          () => context.close(),
          ...(maintHandle === null ? [] : [() => maintHandle.close()]),
        ],
      });
      if (stopping) {
        await shutdown();
      } else {
        keepAlive = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
        logger.info({ listening: false }, 'started');
      }
    } finally {
      if (!servicesOwnCleanup) {
        try {
          await context.close();
        } finally {
          await maintHandle?.close();
        }
      }
    }
    return;
  }

  // payout: redisUrl is null (it never reads Redis, ADR-0001 §4.2 #20), so no REDIS provider.
  const context = await createWorkerContext(entry, { config, logger, dbHandles, redisUrl });
  const queue = context.get<QueueRuntime>(JOB_QUEUE);
  if (config.exitAfterInit) {
    logger.info({ listening: false }, 'started');
    await context.close();
    return;
  }
  try {
    await queue.start();
  } catch (error) {
    await queue.stop();
    await context.close();
    throw error;
  }
  // Keep entries alive even while no business module has registered a handler.
  const keepAlive = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
  closeOnSignal(logger, async () => {
    try {
      await queue.stop();
      await context.close();
    } finally {
      clearInterval(keepAlive);
    }
  });
  logger.info({ listening: false }, 'started');
}

/**
 * Loads the configuration, builds the entry and logs one structured `started` line.
 * With COULI_EXIT_AFTER_INIT=1 the entry initialises, closes and lets the process exit with
 * code 0 without opening a port. Any startup failure is logged and sets exit code 1.
 */
export async function runEntry(entry: EntryName): Promise<void> {
  let config: AppConfig | undefined;
  let connections: ConnectionConfig | undefined;
  let maintConnection: MaintConnectionConfig | null = null;
  const problems: string[] = [];
  try {
    try {
      config = loadConfig(process.env);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems);
    }
    try {
      connections = loadConnectionConfig(entry, process.env);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems);
    }
    try {
      maintConnection = loadMaintConnectionConfig(entry, process.env);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems);
    }
    if (problems.length > 0) throw new ConfigError(problems);
  } catch (error) {
    const logger = createRootLogger({ level: 'error', entry, appEnv: 'unknown' });
    if (error instanceof ConfigError) {
      logger.fatal({ problems: error.problems }, 'config_invalid');
    } else {
      logger.fatal({ err: error }, 'config_invalid');
    }
    process.exitCode = 1;
    return;
  }
  if (config === undefined || connections === undefined) return;
  const logger = createRootLogger({ level: config.logLevel, entry, appEnv: config.appEnv });
  let handles: DbHandles | undefined;
  let maintHandle: MaintDbHandle | null = null;
  try {
    handles = createDbHandles(connections, { logger });
    if (maintConnection !== null) maintHandle = createMaintDbHandle(maintConnection, { logger });
    await start(entry, config, logger, handles, maintHandle, connections.redisUrl);
  } catch (error) {
    await handles?.close();
    await maintHandle?.close();
    logger.fatal({ err: error }, 'startup_failed');
    process.exitCode = 1;
  }
}
