// B1-31: the first thing an entry process does, before its entry module (and with it Nest, pg and
// the queue) is loaded: read the configuration and start tracing when it is configured, so the
// http / pg / undici instrumentations are in place before those modules are first used. A
// configuration problem is not reported here (runEntry reports it the usual way); tracing is then
// simply off. Imported by main.<entry>.ts straight from this file: nothing else of the platform
// (no database module) may load before the hook is registered.
import { ConfigError, loadConfig, type AppConfig } from '../config/index.ts';
import type { EntryName } from '../entries.ts';
import { createRootLogger } from '../logging/index.ts';
import { startTracing, type TracingHandle } from './otel.ts';

const OFF: TracingHandle = Object.freeze({ enabled: false, shutdown: () => Promise.resolve() });

export async function bootTracing(entry: EntryName): Promise<TracingHandle> {
  let config: AppConfig;
  try {
    config = loadConfig(process.env);
  } catch (error: unknown) {
    if (error instanceof ConfigError) return OFF;
    throw error;
  }
  if (config.tracing === undefined) return OFF;
  const logger = createRootLogger({
    level: config.logLevel,
    entry,
    appEnv: config.appEnv,
    deployVersion: config.deployVersion,
  });
  return startTracing({ entry, config, logger });
}
