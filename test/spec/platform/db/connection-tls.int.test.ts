// Contract addendum 2 (code review round 4, path B), on the wire: see the header of
// connection-tls.test.ts. A stand-in server on 127.0.0.1 records the first message of every
// connection; when it is an SSLRequest it answers 'S', so pg starts TLS and the options it hands
// to tls.connect are recorded (then the stand-in hangs up); when it is a plain StartupMessage it
// asks for a clear-text password and records it. So for every sslmode, both handles and a
// password with percent-encoded % @ : # /, the TLS settings and the decoded fields that pg
// really uses are checked exactly. Against the test PostgreSQL (TLS off), require and
// verify-full fail with pg's "The server does not support SSL connections" and never fall back
// to a plain connection. Top-level it() only (规划/11 §4.3).
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
import { ENTRIES, describeError, memoryLogger, phraseOf } from './kit.ts';

const ROOT_PATH = fileURLToPath(import.meta.url);
const ROOT = encodeURIComponent(ROOT_PATH);
const ROOT_TEXT = readFileSync(ROOT_PATH, 'utf8');
const QUERY_MESSAGE =
  'query parameters may only be sslmode (disable, require, verify-ca or verify-full), sslrootcert (required by verify-ca, allowed with verify-full), options, password or sslpassword, each at most once and with a literal name';
const SSL_REQUEST = 80877103;
const PROTOCOL_3 = 196608;

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

interface Seen {
  first: 'ssl-request' | 'startup' | 'other';
  params?: Record<string, string>;
  password?: string;
}

/** The stand-in server; `seen` gets one record per connection, in order. */
async function standIn(): Promise<{ port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const record: Seen = { first: 'other' };
    seen.push(record);
    let buffer = Buffer.alloc(0);
    let stage: 'first' | 'tls' | 'password' = 'first';
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'tls') {
        socket.destroy();
        return;
      }
      if (stage === 'first') {
        if (buffer.length < 8) return;
        const length = buffer.readInt32BE(0);
        const code = buffer.readInt32BE(4);
        if (length === 8 && code === SSL_REQUEST) {
          record.first = 'ssl-request';
          stage = 'tls';
          socket.write('S');
          return;
        }
        if (buffer.length < length) return;
        if (code !== PROTOCOL_3) {
          socket.destroy();
          return;
        }
        record.first = 'startup';
        const parts = buffer
          .subarray(8, length - 1)
          .toString('utf8')
          .split('\0');
        const params: Record<string, string> = {};
        for (let i = 0; i + 1 < parts.length; i += 2) params[parts[i] ?? ''] = parts[i + 1] ?? '';
        record.params = params;
        buffer = buffer.subarray(length);
        stage = 'password';
        socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 3]));
        return;
      }
      if (buffer.length < 5 || buffer[0] !== 0x70) return;
      const length = buffer.readInt32BE(1);
      if (buffer.length < 1 + length) return;
      record.password = buffer.subarray(5, length).toString('utf8');
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    seen,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** What pg handed to tls.connect, without the socket; functions described by behaviour. */
function tlsView(options: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === 'socket') continue;
    if (typeof value === 'function') {
      const result: unknown = (value as (host: string, cert: unknown) => unknown)(
        'elsewhere.invalid',
        { subject: { CN: 'someone.else' }, subjectaltname: 'DNS:someone.else' },
      );
      view[key] =
        result === undefined ? 'function returning undefined' : 'function returning an error';
    } else {
      view[key] = value;
    }
  }
  return view;
}

const MODES = [
  { query: '', tls: null },
  { query: 'sslmode=disable', tls: null },
  { query: 'sslmode=require', tls: { rejectUnauthorized: false } },
  {
    query: `sslmode=verify-ca&sslrootcert=${ROOT}`,
    tls: {
      rejectUnauthorized: true,
      ca: ROOT_TEXT,
      checkServerIdentity: 'function returning undefined',
    },
  },
  // verify-full: amended by addendum 3 (connection-hardening.test.ts) — checkServerIdentity
  // checks the URL host, so a certificate for another name fails.
  {
    query: 'sslmode=verify-full',
    tls: { rejectUnauthorized: true, checkServerIdentity: 'function returning an error' },
  },
  {
    query: `sslrootcert=${ROOT}&sslmode=verify-full`,
    tls: {
      rejectUnauthorized: true,
      ca: ROOT_TEXT,
      checkServerIdentity: 'function returning an error',
    },
  },
  { query: 'sslmode=disable&password=', tls: null },
] as const;

for (const entry of ENTRIES) {
  const handles = entry === 'admin' ? (['db', 'dbRead'] as const) : (['db'] as const);
  it(`[ADR-0002 §5; 路径 B 契约补充 2] ${entry}：每种 sslmode 下（${handles.join('、')}）首个报文与交给 tls.connect 的设置确切——不带或 disable 走明文且用户名、库名、口令（含编码的 % @ : # /）解码正确；require / verify-ca / verify-full 先发 SSLRequest，TLS 设置与声明一致、不比声明弱`, async () => {
    const server = await standIn();
    const role = entry === 'payout' ? 'couli_payout' : 'couli_app';
    const plain = phraseOf(`wire.${entry}`);
    const special = `p%w@o:r#d/${plain}`;
    const tlsCalls: Record<string, unknown>[] = [];
    const spy = vi.spyOn(tls, 'connect').mockImplementation(((options: Record<string, unknown>) => {
      tlsCalls.push(tlsView(options));
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
      for (const mode of MODES) {
        for (const password of [plain, special]) {
          // The query password (pg's precedence) is the one that counts when the URL has both.
          const viaQuery = mode.query.endsWith('&password=');
          const query = viaQuery ? `${mode.query}${encodeURIComponent(password)}` : mode.query;
          const url = (user: string): string =>
            `postgres://${password === special ? user.replace('_', '%5F') : user}:${
              viaQuery ? 'not-this-one' : encodeURIComponent(password)
            }@127.0.0.1:${String(server.port)}/couli${query === '' ? '' : `?${query}`}`;
          const env: Record<string, string> = {
            DATABASE_URL: url(role),
            DATABASE_READ_URL: url('couli_readonly'),
            REDIS_URL: 'redis://127.0.0.1:1/0',
          };
          for (const handle of handles) {
            const seenBefore = server.seen.length;
            const tlsBefore = tlsCalls.length;
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
            const record = server.seen.slice(seenBefore);
            results.push({
              mode: mode.query,
              handle,
              outcome,
              first: record.map((r) => r.first),
              startup:
                record[0]?.params === undefined
                  ? null
                  : {
                      user: record[0].params['user'],
                      database: record[0].params['database'],
                      application_name: record[0].params['application_name'],
                      options: record[0].params['options'] ?? null,
                    },
              password: record[0]?.password ?? null,
              tls: tlsCalls.slice(tlsBefore),
            });
            const plainWire = mode.tls === null;
            expected.push({
              mode: mode.query,
              handle,
              outcome: 'rejected',
              first: [plainWire ? 'startup' : 'ssl-request'],
              startup: plainWire
                ? {
                    user: handle === 'db' ? role : 'couli_readonly',
                    database: 'couli',
                    application_name: handle === 'db' ? `couli-${entry}` : 'couli-admin-read',
                    options: handle === 'db' ? null : '-c default_transaction_read_only=on',
                  }
                : null,
              password: plainWire ? password : null,
              tls: plainWire ? [] : [mode.tls],
            });
          }
        }
      }
    } finally {
      spy.mockRestore();
      await server.close();
    }
    expect({ results, lines }).toStrictEqual({ results: expected, lines: [] });
  });
}

it('[ADR-0002 §5; 路径 B 契约补充 2] 对不开 TLS 的测试库：require 与 verify-full 都以「The server does not support SSL connections」失败、不退回明文（db 与 dbRead）；disable 照常连上；prefer 在建池前就被拒绝', async () => {
  const { logger, lines } = memoryLogger('admin');
  const outcome = async (query: string): Promise<unknown> => {
    try {
      const made = createDbHandles(
        loadConnectionConfig('admin', {
          DATABASE_URL: `${database.urlFor('couli_app')}?${query}`,
          DATABASE_READ_URL: `${database.urlFor('couli_readonly')}?${query}`,
          REDIS_URL: 'redis://127.0.0.1:1/0',
        }),
        { logger },
      );
      const one = async (db: Kysely<DB>): Promise<string> => {
        try {
          const result = await sql<{ one: number }>`SELECT 1 AS one`.execute(db);
          return `connected ${String(result.rows[0]?.one)}`;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      const seen = [await one(made.db), await one(made.dbRead as Kysely<DB>)];
      await made.close();
      return seen;
    } catch (error) {
      return describeError(error);
    }
  };
  const refusedByServer = 'The server does not support SSL connections';
  expect({
    require: await outcome('sslmode=require'),
    verifyFull: await outcome('sslmode=verify-full'),
    disable: await outcome('sslmode=disable'),
    prefer: await outcome('sslmode=prefer'),
    lines,
  }).toStrictEqual({
    require: [refusedByServer, refusedByServer],
    verifyFull: [refusedByServer, refusedByServer],
    disable: ['connected 1', 'connected 1'],
    prefer: `ConfigError ${JSON.stringify([`DATABASE_URL: ${QUERY_MESSAGE}`, `DATABASE_READ_URL: ${QUERY_MESSAGE}`])}`,
    lines: [],
  });
});
