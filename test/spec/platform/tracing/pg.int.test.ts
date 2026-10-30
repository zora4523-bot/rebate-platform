// [AC-B1-31#7] API → DB → external dependency in one trace (05 B1-31 acceptance, here against a
// real PostgreSQL and loopback servers): a query through the entry's database handles leaves a
// span with db.system postgresql in the active trace, and an external fetch in the same trace leaves
// its client span. [AC-B1-31#10] the exported spans carry neither the query's parameter values nor
// the database password.
// Int test: a clone of the migrated template (ADR-0001 §4.2 #9), business role only. Tracing starts
// before pg is first loaded, so the database helpers are imported only after it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { afterAll, expect, it } from 'vitest';
import { startTracing } from '../../../../apps/api/src/modules/platform/tracing/otel.ts';
import {
  CLIENT,
  ENDPOINT_VAR,
  EXPORT_WAIT_MS,
  attributeOf,
  configOf,
  lazily,
  memoryLogger,
  otelApi,
  startReceiver,
  waitFor,
  type ReceivedSpan,
  type Receiver,
} from './kit.ts';

interface Setup {
  readonly receiver: Receiver;
  readonly password: string;
  query(marker: string): Promise<string | undefined>;
  readonly upstreamUrl: string;
}

/** Run in order by afterAll, also when the setup failed halfway. */
const cleanups: (() => Promise<void>)[] = [];

const setup = lazily(async (): Promise<Setup> => {
  const receiver = await startReceiver();
  cleanups.push(() => receiver.close());
  const { logger } = memoryLogger('api');
  const config = configOf({ [ENDPOINT_VAR]: receiver.url });
  const handle = await startTracing({ entry: 'api', config, logger });
  expect(handle.enabled).toBe(true);
  cleanups.unshift(() => handle.shutdown());
  // pg is loaded from here on, after the instrumentation was registered (as in the entries).
  const { createTestDatabase } = await import('@couli/db/testing');
  const database = await createTestDatabase();
  cleanups.unshift(() => database.drop());
  const db = await import('../../../../apps/api/src/modules/platform/db/index.ts');
  const url = database.urlFor('couli_app');
  const handles = db.createDbHandles(
    db.loadConnectionConfig('api', { DATABASE_URL: url, REDIS_URL: 'redis://127.0.0.1:1/0' }),
    { logger },
  );
  cleanups.unshift(() => handles.close());
  const server = http.createServer((_req, res) => res.end('{}'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.unshift(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    receiver,
    password: decodeURIComponent(new URL(url).password),
    query: async (marker) => {
      const result = await sql<{ v: string }>`select ${marker}::text as v`.execute(handles.db);
      return result.rows[0]?.v;
    },
    upstreamUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/external`,
  };
});

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

function isPostgres(span: ReceivedSpan): boolean {
  return attributeOf(span.attributes, 'db.system.name', 'db.system') === 'postgresql';
}

it('[AC-B1-31#7] a query and an external call inside one active span: a postgresql span and a client span in that trace', async () => {
  const { receiver, query, upstreamUrl } = await setup();
  const tracer = otelApi().trace.getTracer('b1-31-rule');
  const marker = 'b131pgparam7c0e';
  const parent = await tracer.startActiveSpan('b1-31-request', async (span) => {
    try {
      expect(await query(marker)).toBe(marker);
      const response = await fetch(upstreamUrl);
      await response.text();
      return span.spanContext();
    } finally {
      span.end();
    }
  });
  const inTrace = () => receiver.spans().filter((span) => span.traceId === parent.traceId);
  expect(
    await waitFor(
      () =>
        inTrace().some(isPostgres) &&
        inTrace().some((span) => span.kind === CLIENT && !isPostgres(span)),
      EXPORT_WAIT_MS,
    ),
  ).toBe(true);
  const pgSpans = inTrace().filter(isPostgres);
  expect(pgSpans.length).toBeGreaterThanOrEqual(1);
  // The query span itself (not only a connect span) is there, as a client span of this trace.
  const statementOf = (span: ReceivedSpan): string =>
    String(attributeOf(span.attributes, 'db.query.text', 'db.statement') ?? '');
  expect(
    pgSpans.some((span) => span.kind === CLIENT && statementOf(span).includes('::text as v')),
  ).toBe(true);
});

it('[AC-B1-31#10] exported spans carry no query parameter value and no database password', async () => {
  const { receiver, query, password } = await setup();
  const tracer = otelApi().trace.getTracer('b1-31-rule');
  const marker = 'b131pgsecret3e5b';
  const traceId = await tracer.startActiveSpan('b1-31-private', async (span) => {
    try {
      expect(await query(marker)).toBe(marker);
      return span.spanContext().traceId;
    } finally {
      span.end();
    }
  });
  expect(
    await waitFor(
      () => receiver.spans().some((span) => span.traceId === traceId && isPostgres(span)),
      EXPORT_WAIT_MS,
    ),
  ).toBe(true);
  expect(password.length).toBeGreaterThan(0);
  for (const request of receiver.requests) {
    expect(request.body.includes(marker)).toBe(false);
    expect(request.body.includes(password)).toBe(false);
  }
});
