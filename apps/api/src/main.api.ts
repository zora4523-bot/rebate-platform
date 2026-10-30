// Entry `api`: user-facing HTTP API (`/v1`). Listens on API_HOST:API_PORT.
// B1-31: tracing starts before the entry module is loaded (instrumentation precedes http / pg /
// undici); the entry module is imported only afterwards.
import 'reflect-metadata';
import { bootTracing } from './modules/platform/tracing/boot.ts';

// The entry owns the shutdown of tracing (runEntry: with its close on a signal, after a startup
// failure, or at once with COULI_EXIT_AFTER_INIT); runEntry returns while the entry still serves.
await bootTracing('api');
const { runEntry } = await import('./entry.ts');
await runEntry('api');
