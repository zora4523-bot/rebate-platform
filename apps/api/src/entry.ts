// Shared runner behind the five `main.<entry>.ts` files.
import { createHttpApp, createWorkerContext } from './bootstrap.ts';
import {
  type AppConfig,
  type ConnectionConfig,
  type DbHandles,
  ConfigError,
  type EntryName,
  type HttpEntry,
  type RootLogger,
  createRootLogger,
  createDbHandles,
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
): Promise<void> {
  if (isHttpEntry(entry)) {
    const app = await createHttpApp(entry, { config, logger, dbHandles });
    try {
      await app.init();
      if (config.exitAfterInit) {
        logger.info({ listening: false }, 'started');
        await app.close();
        return;
      }
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

  const context = await createWorkerContext(entry, { config, logger, dbHandles });
  logger.info({ listening: false }, 'started');
  if (config.exitAfterInit) {
    await context.close();
    return;
  }
  // No job runner exists yet, so nothing else holds the event loop open.
  // TODO(ADR-0001 §2): the pg-boss job runner replaces this timer — blocked on B1-01.
  const keepAlive = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
  closeOnSignal(logger, async () => {
    clearInterval(keepAlive);
    await context.close();
  });
}

/**
 * Loads the configuration, builds the entry and logs one structured `started` line.
 * With COULI_EXIT_AFTER_INIT=1 the entry initialises, closes and lets the process exit with
 * code 0 without opening a port. Any startup failure is logged and sets exit code 1.
 */
export async function runEntry(entry: EntryName): Promise<void> {
  let config: AppConfig | undefined;
  let connections: ConnectionConfig | undefined;
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
  try {
    handles = createDbHandles(connections, { logger });
    await start(entry, config, logger, handles);
  } catch (error) {
    await handles?.close();
    logger.fatal({ err: error }, 'startup_failed');
    process.exitCode = 1;
  }
}
