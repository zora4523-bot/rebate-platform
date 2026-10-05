import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { decodeBase32 } from '../domain/totp.ts';
import {
  BOOTSTRAP_EXIT,
  MAX_CODE_ATTEMPTS,
  createAdminBootstrap,
  encodeBase32,
  type BootstrapDeps,
} from './bootstrap.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// RFC 6238 Appendix B 公开测试种子（ASCII "12345678901234567890"），非密钥；运行时按 RFC 4648 编成 Base32。
// 用本地独立编码而非被测的 encodeBase32，#1 的断言才不是同义反复。
const RFC_KEY = rfc4648Base32(Buffer.from('12345678901234567890', 'ascii'));
function rfc4648Base32(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) ?? [])
    .map((group) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[Number.parseInt(group.padEnd(5, '0'), 2)])
    .join('');
}
const PASSWORD = 'unit fixture password, never deployed';

// Real Kysely SQL compilation over an in-memory driver; `superRows` answers the super check.
function fixture(options: { superExists?: boolean; codes?: (string | null)[]; tty?: boolean }) {
  const driver = new DummyDriver();
  const queries: CompiledQuery[] = [];
  driver.acquireConnection = async () => ({
    executeQuery: async <R>(query: CompiledQuery) => {
      queries.push(query);
      const isSuperCheck = query.sql.startsWith('select') && query.sql.includes('"is_super"');
      return { rows: (isSuperCheck && options.superExists === true ? [{ id: 'x' }] : []) as R[] };
    },
    streamQuery: async function* () {
      throw new Error('not used');
    },
  });
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }).withSchema('app');
  handles.push(db);
  const codes = [...(options.codes ?? [])];
  const bindings: string[] = [];
  const messages: string[] = [];
  const reads = { password: 0, code: 0 };
  const deps: BootstrapDeps = {
    db,
    clock: new FixedClock('1970-01-01T00:00:59Z'),
    crypto: { encrypt: (plain) => `enc:${plain}`, decrypt: (cipher) => cipher.slice(4) },
    generateTotpSecret: () => Buffer.from('12345678901234567890', 'ascii'),
    newAdminId: () => '019a0000-0000-7000-8000-0000000000aa',
    hashPassword: async () => 'hash',
    audit: () => ({ append: async () => undefined }),
    terminal: {
      isTTY: options.tty ?? true,
      readPassword: async () => {
        reads.password += 1;
        return PASSWORD;
      },
      readCode: async () => {
        reads.code += 1;
        return codes.shift() ?? null;
      },
      showBinding: (uri) => bindings.push(uri),
      write: (message) => messages.push(message),
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    activeStatus: 'unit-active',
    issuer: 'Unit',
  };
  return { deps, queries, bindings, messages, reads };
}

const REQUEST = { appId: 'couli', loginName: 'owner' };

it('[AC-F1-06c-UNIT#1] Base32 encoding matches RFC 4648 and round-trips through the verifier decoder', () => {
  expect(encodeBase32(Buffer.from('12345678901234567890', 'ascii'))).toBe(RFC_KEY);
  expect(encodeBase32(Buffer.from('foobar', 'ascii'))).toBe('MZXW6YTBOI');
  expect(encodeBase32(Buffer.from('f', 'ascii'))).toBe('MY');
  const bytes = Buffer.from([0, 255, 1, 254, 2, 253, 3, 252, 4, 251, 5, 250, 6, 249, 7, 248, 9]);
  expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
});

it('[AC-F1-06c-UNIT#2] a non-terminal run refuses before touching the database or the input', async () => {
  const f = fixture({ tty: false });
  const result = await createAdminBootstrap(f.deps).run(REQUEST);
  expect(result.exitCode).toBe(BOOTSTRAP_EXIT.invalid);
  expect(f.queries).toEqual([]);
  expect(f.reads).toEqual({ password: 0, code: 0 });
});

it('[AC-F1-06c-UNIT#3] an existing super refuses before reading a password or showing a binding', async () => {
  const f = fixture({ superExists: true });
  const result = await createAdminBootstrap(f.deps).run(REQUEST);
  expect(result.exitCode).toBe(BOOTSTRAP_EXIT.superExists);
  expect(f.reads).toEqual({ password: 0, code: 0 });
  expect(f.bindings).toEqual([]);
});

it('[AC-F1-06c-UNIT#4] wrong codes are retried a bounded number of times and never start a transaction', async () => {
  const f = fixture({ codes: Array<string>(MAX_CODE_ATTEMPTS + 2).fill('000000') });
  const result = await createAdminBootstrap(f.deps).run(REQUEST);
  expect(result.exitCode).toBe(BOOTSTRAP_EXIT.notConfirmed);
  expect(f.reads.code).toBe(MAX_CODE_ATTEMPTS);
  expect(f.bindings).toHaveLength(1);
  expect(f.queries.some((query) => /insert|advisory/i.test(query.sql))).toBe(false);
});

it('[AC-F1-06c-UNIT#5] invalid login names and short passwords are refused without a binding', async () => {
  const bad = fixture({});
  expect(
    (await createAdminBootstrap(bad.deps).run({ ...REQUEST, loginName: ' owner' })).exitCode,
  ).toBe(BOOTSTRAP_EXIT.invalid);
  expect(bad.queries).toEqual([]);
  const short = fixture({});
  const bootstrap = createAdminBootstrap({
    ...short.deps,
    terminal: { ...short.deps.terminal, readPassword: async () => 'short' },
  });
  expect((await bootstrap.run(REQUEST)).exitCode).toBe(BOOTSTRAP_EXIT.invalid);
  expect(short.bindings).toEqual([]);
});

it('[AC-F1-06c-UNIT#6] the binding URI carries the secret, issuer and login, and nothing else is printed', async () => {
  const f = fixture({ codes: [null] });
  await createAdminBootstrap(f.deps).run(REQUEST);
  expect(f.bindings).toHaveLength(1);
  const uri = new URL(f.bindings[0]!);
  expect(uri.protocol).toBe('otpauth:');
  expect(uri.searchParams.get('secret')).toBe(RFC_KEY);
  expect(uri.searchParams.get('issuer')).toBe('Unit');
  expect(decodeURIComponent(uri.pathname)).toBe('/Unit:owner');
  expect(f.messages.join('\n')).not.toContain(RFC_KEY);
});

it('[AC-F1-06c-UNIT#7] the app id and login name must be confirmed with yes before a password or binding', async () => {
  for (const answer of [null, 'no', 'y', 'YES ', '']) {
    const f = fixture({ codes: [null] });
    const questions: string[] = [];
    const bootstrap = createAdminBootstrap({
      ...f.deps,
      terminal: {
        ...f.deps.terminal,
        readConfirmation: async (question) => {
          questions.push(question);
          return answer;
        },
      },
    });
    expect((await bootstrap.run(REQUEST)).exitCode).toBe(BOOTSTRAP_EXIT.invalid);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('couli');
    expect(questions[0]).toContain('owner');
    expect(f.reads).toEqual({ password: 0, code: 0 });
    expect(f.bindings).toEqual([]);
    expect(f.queries.some((query) => /insert|advisory/i.test(query.sql))).toBe(false);
  }
  const ok = fixture({ codes: [null] });
  const confirmed = createAdminBootstrap({
    ...ok.deps,
    terminal: { ...ok.deps.terminal, readConfirmation: async () => ' yes\n' },
  });
  expect((await confirmed.run(REQUEST)).exitCode).toBe(BOOTSTRAP_EXIT.notConfirmed);
  expect(ok.reads.password).toBe(1);
  expect(ok.bindings).toHaveLength(1);
});
