// Shared runner behind the five `main.<entry>.ts` files.
import { createHttpApp, createWorkerContext } from './bootstrap.ts';
import { agentSweeperToken, type AgentSweeperRuntime } from './modules/agent/index.ts';
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
import { orderSyncToken, type OrderSyncRuntime } from './modules/orders/index.ts';
import { riskScanToken, seedRiskScan, startRiskScanHeal } from './modules/risk/index.ts';

// Keeps a worker process alive until a signal arrives; longer than any deployment lives.
const KEEP_ALIVE_INTERVAL_MS = 2 ** 30;

function portOf(entry: HttpEntry, config: AppConfig): number {
  if (entry === 'api') return config.apiPort;
  if (entry === 'stream') return config.streamPort;
  return config.adminPort;
}

interface StartupSignals {
  /** True once the first SIGTERM / SIGINT arrived (also during startup). */
  stopping(): boolean;
  /** Startup finished after a signal: close now and log `stopped` (or `shutdown_failed`). */
  stop(close: () => Promise<void>): Promise<void>;
  /** Startup finished: log `started` and close on the first signal, or close now if one came. */
  serve(close: () => Promise<void>, started: Record<string, unknown>): Promise<void>;
  /**
   * Startup failed and its cleanup begins: later signals are absorbed without a `stopping`
   * line (B1-01zs), so cleanup finishes and the process still ends with `startup_failed`, 1.
   */
  fail(): void;
  /** Failure cleanup finished: remove the handlers (runEntry, after `startup_failed`). */
  detach(): void;
}

/**
 * Installs the SIGTERM / SIGINT handlers before startup begins (not with COULI_EXIT_AFTER_INIT).
 * A signal during startup logs `stopping` once; startup owns cleanup until it finishes, so
 * nothing still starting is closed underneath it. Repeated signals are absorbed. Every entry,
 * the worker included, goes through this one watcher (B1-01zs).
 */
function watchSignals(logger: RootLogger, attach: boolean): StartupSignals {
  let stopping = false;
  let failed = false;
  let close: (() => Promise<void>) | undefined;
  const shutdown = async (run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      logger.info('stopped');
    } catch (error) {
      logger.error({ err: error }, 'shutdown_failed');
      process.exitCode = 1;
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping || failed) return;
    stopping = true;
    logger.info({ signal }, 'stopping');
    if (close !== undefined) void shutdown(close);
  };
  if (attach) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }
  return {
    stopping: () => stopping,
    stop: shutdown,
    async serve(run, started) {
      if (stopping) {
        await shutdown(run);
        return;
      }
      close = run;
      logger.info(started, 'started');
    },
    fail() {
      failed = true;
    },
    detach() {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    },
  };
}

/**
 * The worker's order-sync loops (B1-08n): resolved and started only while no stop was requested.
 * Older or isolated worker contexts may lack the runtime; that is not a startup failure.
 */
function startOrderSync(
  resolve: () => unknown,
  queue: QueueRuntime,
  stopping: () => boolean,
): { stop(): Promise<void> } | undefined {
  if (stopping()) return undefined;
  let runtime: Partial<OrderSyncRuntime> | null | undefined;
  try {
    runtime = resolve() as Partial<OrderSyncRuntime> | null | undefined;
  } catch {
    return undefined;
  }
  if (stopping() || runtime === (queue as unknown) || typeof runtime?.start !== 'function') {
    return undefined;
  }
  try {
    return runtime.start();
  } catch {
    return undefined;
  }
}

/** A start step whose rejection marks the startup as failed before any cleanup runs. */
function failFirst(
  signals: StartupSignals,
  part: { start(): Promise<void>; stop(): Promise<void> },
): { start(): Promise<void>; stop(): Promise<void> } {
  return {
    start: () =>
      part.start().catch((error: unknown) => {
        signals.fail();
        throw error;
      }),
    stop: () => part.stop(),
  };
}

async function start(
  entry: EntryName,
  config: AppConfig,
  logger: RootLogger,
  dbHandles: DbHandles,
  maintHandle: MaintDbHandle | null,
  redisUrl: ConnectionConfig['redisUrl'],
  signals: StartupSignals,
): Promise<void> {
  if (isHttpEntry(entry)) {
    const app = await createHttpApp(entry, { config, logger, dbHandles, redisUrl });
    const close = (): Promise<void> => app.close();
    try {
      if (signals.stopping()) {
        await signals.stop(close);
        return;
      }
      await app.init();
      if (config.exitAfterInit) {
        logger.info({ listening: false }, 'started');
        await app.close();
        return;
      }
      if (signals.stopping()) {
        await signals.stop(close);
        return;
      }
      await app.get<QueueRuntime>(JOB_QUEUE).start();
      // A signal during queue start: never open the port, just close.
      if (signals.stopping()) {
        await signals.stop(close);
        return;
      }
      const port = portOf(entry, config);
      await app.listen(port, config.apiHost);
      await signals.serve(close, { listening: true, host: config.apiHost, port });
    } catch (error) {
      signals.fail();
      await app.close();
      throw error;
    }
    return;
  }

  if (entry === 'worker') {
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
      // A failed start step marks the failure (failFirst) before startWorkerServices cleans up,
      // so a signal during that cleanup logs no `stopping` (B1-01zs).
      const services = await startWorkerServices({
        queue: failFirst(signals, queue),
        maintenance: maintenance === null ? null : failFirst(signals, maintenance),
        logger,
        close: [
          () => context.close(),
          ...(maintHandle === null ? [] : [() => maintHandle.close()]),
        ],
      });
      // Startup owns cleanup until here. A signal during startup stops the services now: no
      // `started` line and no keep-alive timer (B1-01t contract 7 c).
      if (signals.stopping()) {
        await signals.stop(() => services.stop());
        return;
      }
      // The risk-scan chain (B1-03j): its current-slot seeds, now that the queue runs. A failed
      // seed is a warn line only; a signal that arrived meanwhile sends nothing.
      const resolveScan = (): unknown => context.get<unknown>(riskScanToken(), { strict: false });
      await seedRiskScan(resolveScan, logger, () => signals.stopping());
      // The chain's self-heal (B1-03u): re-sends both next slots every five minutes, so a failed
      // continuation does not stop the scans until the next worker start. Started even after a
      // failed seed; stopped first on shutdown, before the services.
      const heal = startRiskScanHeal(resolveScan, logger, () => signals.stopping());
      let runtime: Partial<AgentSweeperRuntime> | null | undefined;
      if (!signals.stopping()) {
        try {
          runtime = context.get<Partial<AgentSweeperRuntime> | null | undefined>(
            agentSweeperToken(),
            { strict: false },
          );
        } catch {
          // Older or isolated worker contexts may not provide the optional runtime.
        }
      }
      const loop =
        !signals.stopping() &&
        runtime !== (queue as unknown) &&
        typeof runtime?.start === 'function'
          ? runtime.start()
          : undefined;
      // Order sync (B1-08n): the scheduler's timer loops, started once the queue runs (nothing is
      // dispatched at start). Optional like the agent runtime: a throw, null, a value without a
      // start function, a failing start or a stop already requested → no loops, no crash, no log.
      const sync = startOrderSync(
        () => context.get<unknown>(orderSyncToken(), { strict: false }),
        queue,
        () => signals.stopping(),
      );
      const keepAlive = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
      await signals.serve(
        async () => {
          try {
            heal.stop();
            try {
              try {
                await sync?.stop();
              } finally {
                await loop?.stop();
              }
            } finally {
              await services.stop();
            }
          } finally {
            clearInterval(keepAlive);
          }
        },
        { listening: false },
      );
    } catch (error) {
      signals.fail();
      throw error;
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
  if (signals.stopping()) {
    await signals.stop(() => context.close());
    return;
  }
  try {
    await queue.start();
  } catch (error) {
    signals.fail();
    await queue.stop();
    await context.close();
    throw error;
  }
  // Keep entries alive even while no business module has registered a handler.
  const keepAlive = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
  await signals.serve(
    async () => {
      try {
        await queue.stop();
        await context.close();
      } finally {
        clearInterval(keepAlive);
      }
    },
    { listening: false },
  );
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
  // Installed before anything is created; removed only after a failed startup's cleanup, so a
  // signal during that cleanup neither logs `stopping` nor ends the process early (B1-01zs).
  const signals = watchSignals(logger, !config.exitAfterInit);
  try {
    handles = createDbHandles(connections, { logger });
    if (maintConnection !== null) maintHandle = createMaintDbHandle(maintConnection, { logger });
    await start(entry, config, logger, handles, maintHandle, connections.redisUrl, signals);
  } catch (error) {
    signals.fail();
    try {
      await handles?.close();
      await maintHandle?.close();
      logger.fatal({ err: error }, 'startup_failed');
      process.exitCode = 1;
    } finally {
      signals.detach();
    }
  }
}
