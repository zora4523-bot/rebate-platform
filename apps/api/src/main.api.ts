// Entry `api`: user-facing HTTP API (`/v1`). Listens on API_HOST:API_PORT.
// B1-31: tracing starts before the entry module is loaded (instrumentation precedes http / pg /
// undici); the entry module is imported only afterwards. The handle is shut down when the entry
// returns, whatever the outcome.
import 'reflect-metadata';
import { bootTracing } from './modules/platform/tracing/boot.ts';

const tracing = await bootTracing('api');
try {
  const { runEntry } = await import('./entry.ts');
  await runEntry('api');
} finally {
  await tracing.shutdown();
}
