// Contract addendum 3 (code review round 5, path B), on the wire and against the test
// PostgreSQL: see the header of connection-hardening.test.ts.
// - TLS identity: the stand-in server of connection-tls.int.test.ts answers 'S' to the
//   SSLRequest and pg's tls.connect is replaced by a recorder, so the options pg really hands to
//   Node are checked. TCP connections to the URL hosts 10.0.0.10 and db.internal are redirected
//   to the stand-in on 127.0.0.1 (only the target of net.Socket#connect changes; pg still sees
//   the URL host). The recorded checkServerIdentity is called with synthetic certificate objects
//   ({ subject: { CN }, subjectaltname }); no key or certificate file is involved.
// - Control characters: the review's URL is refused before any pool exists (no socket opened);
//   with an allowed `options=-c default_transaction_read_only=off` on a writable role, dbRead
//   still refuses a write with 25006 after RESET ALL and DISCARD ALL on the same connection.
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@couli/db';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createDbHandles,
  loadConnectionConfig,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  ENTRIES,
  configErrorOf,
  configErrorProblems,
  describeError,
  memoryLogger,
  phraseOf,
  watchSocketConnects,
} from './kit.ts';

const ROOT_PATH = fileURLToPath(import.meta.url);
const ROOT = encodeURIComponent(ROOT_PATH);
const ROOT_TEXT = readFileSync(ROOT_PATH, 'utf8');
const CONTROL_MESSAGE = 'connection fields may not contain control characters';
const REVIEW_OPTIONS =
  'options=-c%20default_transaction_read_only%3Doff%00application_name%00report';
const SSL_REQUEST = 80877103;
const ALTNAME = 'ERR_TLS_CERT_ALTNAME_INVALID';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

/** A stand-in that answers 'S' to an SSLRequest and hangs up on anything else. */
async function sslStandIn(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 8) return;
      if (buffer.readInt32BE(0) === 8 && buffer.readInt32BE(4) === SSL_REQUEST) {
        buffer = Buffer.alloc(0);
        socket.write('S');
        return;
      }
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Cert {
  readonly label: string;
  readonly cert: { subject: { CN: string }; subjectaltname: string };
}

const CERTS: readonly Cert[] = [
  {
    label: 'DNS:localhost',
    cert: { subject: { CN: 'localhost' }, subjectaltname: 'DNS:localhost' },
  },
  {
    label: 'IP Address:10.0.0.10',
    cert: { subject: { CN: 'db' }, subjectaltname: 'IP Address:10.0.0.10' },
  },
  {
    label: 'DNS:10.0.0.10',
    cert: { subject: { CN: '10.0.0.10' }, subjectaltname: 'DNS:10.0.0.10' },
  },
  {
    label: 'IP Address:10.0.0.11',
    cert: { subject: { CN: 'db' }, subjectaltname: 'IP Address:10.0.0.11' },
  },
  {
    label: 'DNS:db.internal',
    cert: { subject: { CN: 'db.internal' }, subjectaltname: 'DNS:db.internal' },
  },
  {
    label: 'DNS:other.internal, DNS:db.internal',
    cert: { subject: { CN: 'other' }, subjectaltname: 'DNS:other.internal, DNS:db.internal' },
  },
];

/** What the identity check of `host` must give for each certificate, written out by hand. */
const IDENTITY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '10.0.0.10': {
    'DNS:localhost': `${ALTNAME} host=10.0.0.10`,
    'IP Address:10.0.0.10': 'ok',
    'DNS:10.0.0.10': `${ALTNAME} host=10.0.0.10`,
    'IP Address:10.0.0.11': `${ALTNAME} host=10.0.0.10`,
    'DNS:db.internal': `${ALTNAME} host=10.0.0.10`,
    'DNS:other.internal, DNS:db.internal': `${ALTNAME} host=10.0.0.10`,
  },
  'db.internal': {
    'DNS:localhost': `${ALTNAME} host=db.internal`,
    'IP Address:10.0.0.10': `${ALTNAME} host=db.internal`,
    'DNS:10.0.0.10': `${ALTNAME} host=db.internal`,
    'IP Address:10.0.0.11': `${ALTNAME} host=db.internal`,
    'DNS:db.internal': 'ok',
    'DNS:other.internal, DNS:db.internal': 'ok',
  },
};

function outcomeOf(result: unknown): string {
  if (result === undefined) return 'ok';
  if (result instanceof Error) {
    const { code, host } = result as Error & { code?: unknown; host?: unknown };
    return `${String(code)} host=${String(host)}`;
  }
  return `returned ${typeof result}`;
}

/**
 * The tls.connect options without `socket`; checkServerIdentity is replaced by what it gives
 * for every certificate, each asked as 'localhost', as the URL host and as another name (one
 * value when all three agree, else the three).
 */
function tlsView(options: Record<string, unknown>, host: string): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === 'socket') continue;
    if (key !== 'checkServerIdentity') {
      view[key] = typeof value === 'function' ? 'function' : value;
      continue;
    }
    if (typeof value !== 'function') {
      view[key] = `not a function: ${String(value)}`;
      continue;
    }
    const identity: Record<string, string> = {};
    for (const { label, cert } of CERTS) {
      const asked = ['localhost', host, 'elsewhere.invalid'].map((name) => {
        try {
          return outcomeOf((value as (name: string, cert: unknown) => unknown)(name, cert));
        } catch (error) {
          return `threw ${describeError(error)}`;
        }
      });
      identity[label] = asked.every((one) => one === asked[0])
        ? (asked[0] ?? '')
        : asked.join(' | ');
    }
    view[key] = identity;
  }
  return view;
}

const HOSTS = ['10.0.0.10', 'db.internal'] as const;

const MODES = [
  'sslmode=verify-full',
  `sslmode=verify-full&sslrootcert=${ROOT}`,
  `sslmode=verify-ca&sslrootcert=${ROOT}`,
  'sslmode=require',
] as const;

/** The options tls.connect must receive for `mode` and `host` (addendum 3 §1). */
function expectedTls(mode: (typeof MODES)[number], host: (typeof HOSTS)[number]): unknown {
  const sni = host === 'db.internal' ? { servername: host } : {};
  if (mode === 'sslmode=require') return { rejectUnauthorized: false, ...sni };
  if (mode.startsWith('sslmode=verify-ca')) {
    return {
      rejectUnauthorized: true,
      ca: ROOT_TEXT,
      checkServerIdentity: Object.fromEntries(CERTS.map(({ label }) => [label, 'ok'])),
      ...sni,
    };
  }
  return {
    rejectUnauthorized: true,
    ...(mode.includes('sslrootcert') ? { ca: ROOT_TEXT } : {}),
    checkServerIdentity: IDENTITY[host],
    ...sni,
  };
}

for (const entry of ENTRIES) {
  const handles = entry === 'admin' ? (['db', 'dbRead'] as const) : (['db'] as const);
  it(`[ADR-0002 §5; 路径 B 契约补充 3] ${entry}：verify-full 按连接串里的主机核对证书名（${handles.join('、')}）——IP 主机 10.0.0.10 只认 IP Address:10.0.0.10，DNS:localhost、DNS:10.0.0.10、别的 IP 都失败；域名 db.internal 只认 DNS:db.internal，DNS:localhost 与 IP 都失败；结果与 tls.connect 传入的名字无关；域名带 servername、IP 不带；verify-ca 与 require 的形状不变`, async () => {
    const server = await sslStandIn();
    const role = entry === 'payout' ? 'couli_payout' : 'couli_app';
    const pw = encodeURIComponent(phraseOf(`hardening.wire.${entry}`));
    const original = net.Socket.prototype.connect;
    const redirect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      const target =
        typeof args[0] === 'number' && (HOSTS as readonly unknown[]).includes(args[1])
          ? [args[0], '127.0.0.1', ...args.slice(2)]
          : args;
      return (original as (...a: unknown[]) => net.Socket).apply(this, target);
    } as typeof net.Socket.prototype.connect);
    const calls: Record<string, unknown>[] = [];
    const recorder = vi.spyOn(tls, 'connect').mockImplementation(((
      options: Record<string, unknown>,
    ) => {
      calls.push(options);
      const socket = options['socket'] as net.Socket;
      const fake = new net.Socket();
      queueMicrotask(() => {
        socket.destroy();
        fake.destroy(new Error('stand-in: no TLS here'));
      });
      return fake;
    }) as unknown as typeof tls.connect);
    const { logger, lines } = memoryLogger(entry);
    const results: unknown[] = [];
    const expected: unknown[] = [];
    try {
      for (const host of HOSTS) {
        for (const mode of MODES) {
          const url = (user: string): string =>
            `postgres://${user}:${pw}@${host}:${String(server.port)}/couli?${mode}`;
          const env: Record<string, string> = {
            DATABASE_URL: url(role),
            DATABASE_READ_URL: url('couli_readonly'),
            REDIS_URL: 'redis://127.0.0.1:1/0',
          };
          for (const handle of handles) {
            const before = calls.length;
            let outcome: string;
            try {
              const made = createDbHandles(loadConnectionConfig(entry, env), { logger });
              const target = (handle === 'db' ? made.db : made.dbRead) as Kysely<DB>;
              outcome = await sql`SELECT 1`.execute(target).then(
                () => 'connected',
                () => 'rejected',
              );
              await made.close();
            } catch (error) {
              outcome = describeError(error);
            }
            results.push({
              host,
              mode,
              handle,
              outcome,
              tls: calls.slice(before).map((options) => tlsView(options, host)),
            });
            expected.push({
              host,
              mode,
              handle,
              outcome: 'rejected',
              tls: [expectedTls(mode, host)],
            });
          }
        }
      }
    } finally {
      recorder.mockRestore();
      redirect.mockRestore();
      await server.close();
    }
    expect({ results, lines }).toStrictEqual({ results: expected, lines: [] });
  });
}

it('[ADR-0001 §4.2 #11; 路径 B 契约补充 3] 评审拆分启动报文的 options（%00）以及含 %00 / %0A 的用户名、库名、口令在建任何池之前就被拒绝（admin 的 db 与 dbRead、payout 的 db），一个 TCP 连接都不开、不写日志', () => {
  const { logger, lines } = memoryLogger('admin');
  const watch = watchSocketConnects();
  const readOnly = database.urlFor('couli_readonly');
  const writable = database.urlFor('couli_app');
  const payoutUrl = database.urlFor('couli_payout');
  const at = (url: string, query: string): string => `${url}?${query}`;
  const attempt = (
    entry: 'admin' | 'payout',
    env: Record<string, string>,
    problems: readonly string[],
  ): string[] => {
    const error = configErrorOf(() =>
      createDbHandles(loadConnectionConfig(entry, env), { logger }),
    );
    return typeof error === 'string' ? [error] : configErrorProblems(error, problems);
  };
  const admin = (db: string, read: string, problems: readonly string[]): string[] =>
    attempt(
      'admin',
      { DATABASE_URL: db, DATABASE_READ_URL: read, REDIS_URL: 'redis://127.0.0.1:1/0' },
      problems,
    );
  let seen: unknown;
  try {
    seen = {
      reviewRead: admin(writable, at(writable, REVIEW_OPTIONS), [
        `DATABASE_READ_URL: ${CONTROL_MESSAGE}`,
      ]),
      reviewReadOnlyRole: admin(writable, at(readOnly, REVIEW_OPTIONS), [
        `DATABASE_READ_URL: ${CONTROL_MESSAGE}`,
      ]),
      reviewDb: admin(at(writable, REVIEW_OPTIONS), readOnly, [`DATABASE_URL: ${CONTROL_MESSAGE}`]),
      both: admin(at(writable, 'options=-c%20a%3Db%0A'), at(readOnly, REVIEW_OPTIONS), [
        `DATABASE_URL: ${CONTROL_MESSAGE}`,
        `DATABASE_READ_URL: ${CONTROL_MESSAGE}`,
      ]),
      payoutOptions: attempt('payout', { DATABASE_URL: at(payoutUrl, REVIEW_OPTIONS) }, [
        `DATABASE_URL: ${CONTROL_MESSAGE}`,
      ]),
      payoutUser: attempt(
        'payout',
        { DATABASE_URL: payoutUrl.replace('//couli_payout:', '//couli_payout%00:') },
        [`DATABASE_URL: ${CONTROL_MESSAGE}`],
      ),
      payoutDatabase: attempt(
        'payout',
        { DATABASE_URL: payoutUrl.replace(/\/([^/?#]+)$/, '/$1%00x') },
        [`DATABASE_URL: ${CONTROL_MESSAGE}`],
      ),
      payoutQueryPassword: attempt('payout', { DATABASE_URL: at(payoutUrl, 'password=a%0Ab') }, [
        `DATABASE_URL: ${CONTROL_MESSAGE}`,
      ]),
      connects: watch.count(),
      lines,
    };
  } catch (error) {
    seen = describeError(error);
  } finally {
    watch.restore();
  }
  expect(seen).toStrictEqual({
    reviewRead: [],
    reviewReadOnlyRole: [],
    reviewDb: [],
    both: [],
    payoutOptions: [],
    payoutUser: [],
    payoutDatabase: [],
    payoutQueryPassword: [],
    connects: 0,
    lines: [],
  });
});

it('[ADR-0001 §4.2 #11; 路径 B 契约补充 3] 合规的 options=-c default_transaction_read_only=off 指向可写角色时，dbRead 在同一连接上 RESET ALL、DISCARD ALL 之后写入仍被 PG 以 25006 拒绝，主库照常可写', async () => {
  const consumer = 'rule-test-hardening-reset';
  const { logger, lines } = memoryLogger('admin');
  const writable = database.urlFor('couli_app');
  const write = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return typeof code === 'string' ? code : describeError(error);
    }
    return 'written';
  };
  let seen: unknown;
  try {
    const made = createDbHandles(
      loadConnectionConfig('admin', {
        DATABASE_URL: writable,
        DATABASE_READ_URL: `${writable}?options=${encodeURIComponent('-c default_transaction_read_only=off')}`,
        REDIS_URL: 'redis://127.0.0.1:1/0',
      }),
      { logger },
    );
    const dbRead = made.dbRead as Kysely<DB>;
    const afterReset = (statement: 'RESET ALL' | 'DISCARD ALL'): Promise<string> =>
      dbRead.connection().execute(async (connection) => {
        await sql.raw(statement).execute(connection);
        return write(() =>
          connection
            .insertInto('processed_events')
            .values({ consumer, event_id: randomUUID() })
            .execute(),
        );
      });
    seen = {
      resetAll: await afterReset('RESET ALL'),
      discardAll: await afterReset('DISCARD ALL'),
      primary: await write(() =>
        made.db
          .insertInto('processed_events')
          .values({ consumer, event_id: randomUUID() })
          .execute(),
      ),
      closed: await made.close(),
      lines,
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    resetAll: '25006',
    discardAll: '25006',
    primary: 'written',
    closed: undefined,
    lines: [],
  });
});
