import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Insertable, Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import {
  generateAdminTotpSecret,
  hashAdminPassword,
  verifyAdminPassword,
} from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import { createSuperVerifier } from '../../../../apps/api/src/modules/admin/application/verify-super.ts';
import { createMemoryTotpReplayStore } from '../../../../apps/api/src/modules/admin/infra/totp-replay-memory.ts';
import {
  ACTIVE,
  ADMIN_ID,
  PASSWORD,
  REQUEST,
  SECRET,
  fixture,
  printable,
  snapshot,
} from './fixture.ts';

// Only the integration global setup provisions databases. Each case gets a fresh clone because supers
// cannot be deleted and audits are append-only; never weaken grants/triggers for cleanup.
let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeEach(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (db !== undefined) await destroyDb(db);
  if (database !== undefined) await database.drop();
});

async function seed(patch: Partial<Insertable<DB['admin_users']>> = {}) {
  await db
    .insertInto('admin_users')
    .values({
      id: '019a0000-0000-7000-8000-000000000001',
      app_id: REQUEST.appId,
      login_name: 'preexisting-account',
      password_hash: 'fixture-existing-hash',
      is_super: false,
      status: ACTIVE,
      ...patch,
    })
    .execute();
}

function expectRefusal(result: { exitCode: number }) {
  expect(Number.isInteger(result.exitCode)).toBe(true);
  expect(result.exitCode).toBeGreaterThan(0);
}

it.each(['couli', 'couli_two'])(
  '[AC-F1-06c-BOOTSTRAP#1] confirms before inserting, then persists one bound super and one audit in %s',
  async (appId) => {
    const f = await fixture(db);
    const request = { ...REQUEST, appId };
    const before = await snapshot(db);
    let observedBeforeConfirmation = false;
    const bootstrap = f.create({
      terminal: {
        ...f.deps.terminal,
        readCode: async () => {
          expect(f.bindings).toHaveLength(1);
          expect(await snapshot(db)).toEqual(before);
          observedBeforeConfirmation = true;
          // A fresh code is checked against Clock at input time, not session start.
          f.clock.advanceMs(120_000);
          // Independent RFC 4226 Appendix D counter 5 (t=179s).
          return '254676';
        },
      },
    });
    const result = await bootstrap.run(request);
    expect(result).toEqual({ exitCode: 0 });
    expect(observedBeforeConfirmation).toBe(true);
    const state = await snapshot(db);
    expect(state.users).toHaveLength(1);
    const user = state.users[0]!;
    expect(user).toMatchObject({
      id: ADMIN_ID,
      app_id: appId,
      login_name: REQUEST.loginName,
      password_hash: f.expectedHash,
      is_super: true,
      status: ACTIVE,
      totp_bound_at: f.clock.now(),
      verify_phone_cipher: null,
      verify_phone_hmac: null,
      verify_phone_set_at: null,
    });
    expect(f.passwords).toEqual([PASSWORD]);
    expect(user.password_hash).not.toContain(PASSWORD);
    expect(user.totp_secret_cipher).toBeInstanceOf(Buffer);
    expect(user.totp_secret_cipher!.toString('utf8')).toMatch(/^v1\./);
    expect(user.totp_secret_cipher!.toString('utf8')).not.toContain(SECRET);
    expect(
      f.crypto.decrypt(
        user.totp_secret_cipher!.toString('utf8'),
        `admin_users.totp_secret:${appId}:${ADMIN_ID}`,
      ),
    ).toBe(SECRET);
    expect(state.permissions).toEqual([]);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      app_id: appId,
      admin_id: ADMIN_ID,
      at: f.clock.now(),
      before: null,
      ip: null,
    });
    // Action names and snapshot vocabulary are not prescribed by contracts.
    expect(state.audits[0]!.action.length).toBeGreaterThan(0);
    expect(state.audits[0]!.target).toContain(ADMIN_ID);
    expect(state.audits[0]!.after).not.toBeNull();
    const nonsecret = printable({
      result,
      audits: state.audits,
      logs: f.logs,
      messages: f.messages,
    });
    for (const secret of [SECRET, PASSWORD, f.expectedHash, 'otpauth://', '254676']) {
      expect(nonsecret).not.toContain(secret);
    }
    // Verify the created account through the existing F1-06b public primitive.
    f.clock.advanceMs(30_000);
    const verifier = createSuperVerifier({
      db,
      clock: f.clock,
      crypto: f.crypto,
      replay: createMemoryTotpReplayStore({ clock: f.clock }),
      activeStatus: ACTIVE,
    });
    expect(await verifier.verify({ appId, adminId: ADMIN_ID, code: '287922' })).toEqual({
      appId,
      adminId: ADMIN_ID,
    });
  },
);

it('[AC-F1-06c-BOOTSTRAP#2] ordinary accounts do not prevent first-super creation or get modified', async () => {
  await seed();
  const before = await snapshot(db);
  const f = await fixture(db);
  const bootstrap = f.create();
  expect(await bootstrap.run(REQUEST)).toEqual({ exitCode: 0 });
  const state = await snapshot(db);
  expect(state.users).toHaveLength(2);
  expect(state.users.find((user) => !user.is_super)).toEqual(before.users[0]);
  expect(state.users.filter((user) => user.is_super)).toHaveLength(1);
  expect(state.audits).toHaveLength(1);
});

it.each([
  [
    'active and bound',
    { totp_bound_at: '1970-01-01T00:00:00Z', totp_secret_cipher: Buffer.from('fixture-cipher') },
  ],
  ['disabled', { status: 'f1-06c-fixture-disabled' }],
  ['unbound', { totp_bound_at: null, totp_secret_cipher: null }],
  ['another app', { app_id: 'couli_two' }],
] satisfies [string, Partial<Insertable<DB['admin_users']>>][])(
  '[AC-F1-06c-BOOTSTRAP#3] an existing %s super refuses before disclosing a binding and changes nothing',
  async (_label, patch) => {
    await seed({ is_super: true, ...patch });
    const before = await snapshot(db);
    const f = await fixture(db);
    const bootstrap = f.create();
    expectRefusal(await bootstrap.run(REQUEST));
    expect(await snapshot(db)).toEqual(before);
    expect(f.bindings).toEqual([]);
    expect(f.secretGenerations()).toBe(0);
    expect(f.reads()).toEqual({ password: 0, code: 0 });
    expect(f.passwords).toEqual([]);
  },
);

it.each(['000000', '94287082', '28708x', ' 287082', '２８７０８２', null])(
  '[AC-F1-06c-BOOTSTRAP#4] bad code/EOF %s never commits an account, binding or audit',
  async (code) => {
    const f = await fixture(db);
    const before = await snapshot(db);
    let reads = 0;
    const bootstrap = f.create({
      terminal: { ...f.deps.terminal, readCode: async () => (reads++ === 0 ? code : null) },
    });
    expectRefusal(await bootstrap.run(REQUEST));
    expect(await snapshot(db)).toEqual(before);
    expect(f.bindings).toHaveLength(1);
    expect(printable({ logs: f.logs, messages: f.messages })).not.toContain(SECRET);
  },
);

it('[AC-F1-06c-BOOTSTRAP#5] the displayed URI occurs once, with no copy in logs, files or ordinary output', async () => {
  const f = await fixture(db);
  const bootstrap = f.create();
  const originalCwd = process.cwd();
  const tempRoot = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  await fsPromises.mkdir(tempRoot, { recursive: true });
  const directory = await fsPromises.mkdtemp(`${tempRoot}f1-06c-binding-`);
  let result;
  let sideEffects;
  let files;
  try {
    process.chdir(directory);
    // Monitor actual writes in an isolated workspace as well as the common APIs.
    // A direct/named fs import that bypasses a spy still leaves a detectable file.
    const spies = [
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'appendFileSync'),
      vi.spyOn(fs, 'writeFile'),
      vi.spyOn(fs, 'writeSync'),
      vi.spyOn(fs, 'createWriteStream'),
      vi.spyOn(fsPromises, 'writeFile'),
      vi.spyOn(fsPromises, 'appendFile'),
      vi.spyOn(process.stdout, 'write').mockReturnValue(true),
      vi.spyOn(process.stderr, 'write').mockReturnValue(true),
    ];
    result = await bootstrap.run(REQUEST);
    sideEffects = spies.map((spy) => spy.mock.calls.length);
    files = await fsPromises.readdir(directory, { recursive: true });
  } finally {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
  expect(result).toEqual({ exitCode: 0 });
  expect(sideEffects).toEqual(Array<number>(9).fill(0));
  expect(files).toEqual([]);
  expect(f.bindings).toHaveLength(1);
  const uri = new URL(f.bindings[0]!);
  expect(uri.protocol).toBe('otpauth:');
  expect(uri.hostname).toBe('totp');
  expect(uri.searchParams.get('secret')).toBe(SECRET);
  expect(uri.searchParams.get('issuer')).toBe(f.deps.issuer);
  expect(decodeURIComponent(uri.pathname)).toContain(REQUEST.loginName);
  expect(uri.searchParams.get('algorithm') ?? 'SHA1').toBe('SHA1');
  expect(uri.searchParams.get('digits') ?? '6').toBe('6');
  expect(uri.searchParams.get('period') ?? '30').toBe('30');
  expect(f.secretGenerations()).toBe(1);
  const state = await snapshot(db);
  const ordinary = printable({ result, logs: f.logs, messages: f.messages, audits: state.audits });
  for (const secret of [f.bindings[0]!, SECRET, PASSWORD, '287082', f.expectedHash]) {
    expect(ordinary).not.toContain(secret);
  }
});

it('[AC-F1-06c-BOOTSTRAP#6] a second invocation cannot create, reset or rebind the super', async () => {
  const f = await fixture(db);
  const bootstrap = f.create();
  expect(await bootstrap.run(REQUEST)).toEqual({ exitCode: 0 });
  const before = await snapshot(db);
  const next = await fixture(db);
  const second = next.create();
  expectRefusal(await second.run({ ...REQUEST, loginName: 'another-super' }));
  expect(await snapshot(db)).toEqual(before);
  expect(next.bindings).toEqual([]);
});

it('[AC-F1-06c-BOOTSTRAP#7] audit failure rolls back the account and even an already-inserted audit', async () => {
  const f = await fixture(db);
  const bootstrap = f.create({
    audit: (transaction) => {
      const writer = createAuditWriter({ db: transaction, clock: f.clock });
      return {
        append: async (event) => {
          await writer.append(event);
          throw new Error('fixture-audit-unavailable');
        },
      };
    },
  });
  // Operational failures may propagate or be mapped to a nonzero CLI result.
  const result = await bootstrap.run(REQUEST).catch(() => ({ exitCode: 1 }));
  expectRefusal(result);
  expect(await snapshot(db)).toEqual({ users: [], permissions: [], audits: [] });
});

it.each(['encryption', 'hashing', 'input'] as const)(
  '[AC-F1-06c-BOOTSTRAP#8] %s failure leaves no partially-created account',
  async (failure) => {
    const f = await fixture(db);
    const fail = () => {
      throw new Error(`fixture-${failure}-unavailable`);
    };
    const bootstrap = f.create({
      ...(failure === 'encryption'
        ? { crypto: { encrypt: fail, decrypt: f.crypto.decrypt.bind(f.crypto) } }
        : {}),
      ...(failure === 'hashing' ? { hashPassword: fail } : {}),
      ...(failure === 'input' ? { terminal: { ...f.deps.terminal, readCode: fail } } : {}),
    });
    expectRefusal(await bootstrap.run(REQUEST).catch(() => ({ exitCode: 1 })));
    expect(await snapshot(db)).toEqual({ users: [], permissions: [], audits: [] });
  },
);

it('[AC-F1-06c-BOOTSTRAP#9] duplicate login never promotes or changes an ordinary account', async () => {
  await seed({ login_name: REQUEST.loginName });
  const before = await snapshot(db);
  const f = await fixture(db);
  const bootstrap = f.create();
  expectRefusal(await bootstrap.run(REQUEST).catch(() => ({ exitCode: 1 })));
  expect(await snapshot(db)).toEqual(before);
});

it.each(['nonterminal', 'password EOF'] as const)(
  '[AC-F1-06c-BOOTSTRAP#10] %s refuses without exposing a secret or writing anything',
  async (mode) => {
    const f = await fixture(db);
    const bootstrap = f.create({
      terminal: {
        ...f.deps.terminal,
        isTTY: mode !== 'nonterminal',
        readPassword: mode === 'password EOF' ? async () => null : f.deps.terminal.readPassword,
      },
    });
    expectRefusal(await bootstrap.run(REQUEST));
    expect(f.bindings).toEqual([]);
    if (mode === 'nonterminal') expect(f.reads()).toEqual({ password: 0, code: 0 });
    expect(await snapshot(db)).toEqual({ users: [], permissions: [], audits: [] });
  },
);

it('[AC-F1-06c-BOOTSTRAP#12] a code that expired while the operator was binding cannot create a super', async () => {
  const f = await fixture(db);
  let reads = 0;
  const bootstrap = f.create({
    terminal: {
      ...f.deps.terminal,
      readCode: async () => {
        f.clock.advanceMs(120_000);
        return reads++ === 0 ? '287082' : null;
      },
    },
  });
  expectRefusal(await bootstrap.run(REQUEST));
  expect(await snapshot(db)).toEqual({ users: [], permissions: [], audits: [] });
  expect(f.bindings).toHaveLength(1);
});

// Independent HOTP calculation at fixture Clock t=59s (counter 1).
function confirmationCode(secret: Uint8Array): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(1n);
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

it('[AC-F1-06c-BOOTSTRAP#16] bootstrap persists credentials produced by the production hash and secret functions', async () => {
  const f = await fixture(db);
  let secret: Uint8Array | undefined;
  let encodedHash: string | undefined;
  const bootstrap = f.create({
    generateTotpSecret: () => {
      secret = generateAdminTotpSecret();
      return secret;
    },
    hashPassword: async (password) => {
      encodedHash = await hashAdminPassword(password);
      return encodedHash;
    },
    terminal: {
      ...f.deps.terminal,
      readCode: async () => confirmationCode(secret!),
    },
  });
  expect(await bootstrap.run(REQUEST)).toEqual({ exitCode: 0 });
  expect(secret!.byteLength).toBeGreaterThanOrEqual(20);
  const state = await snapshot(db);
  expect(state.users).toHaveLength(1);
  const user = state.users[0]!;
  expect(user.password_hash).toBe(encodedHash);
  expect(user.password_hash).not.toContain(PASSWORD);
  expect(await verifyAdminPassword(PASSWORD, user.password_hash)).toBe(true);
  expect(await verifyAdminPassword(`${PASSWORD}!`, user.password_hash)).toBe(false);
  expect(user.is_super).toBe(true);
  expect(user.totp_bound_at).toEqual(f.clock.now());
  expect(f.bindings).toHaveLength(1);
  const displayedSecret = new URL(f.bindings[0]!).searchParams.get('secret');
  expect(displayedSecret).toMatch(/^[A-Z2-7]{32,}$/);
  const cipher = user.totp_secret_cipher!.toString('utf8');
  expect(cipher).not.toContain(displayedSecret!);
  expect(f.crypto.decrypt(cipher, `admin_users.totp_secret:${REQUEST.appId}:${ADMIN_ID}`)).toBe(
    displayedSecret,
  );
  expect(state.audits).toHaveLength(1);
  expect(printable({ logs: f.logs, messages: f.messages, audits: state.audits })).not.toContain(
    displayedSecret!,
  );
});

it.each([0, 1, 19])(
  '[AC-F1-06c-BOOTSTRAP#17] a %s-byte secret is refused before disclosure even with its correct code',
  async (length) => {
    const f = await fixture(db);
    const before = await snapshot(db);
    const secret = Buffer.alloc(length, 7);
    const bootstrap = f.create({
      generateTotpSecret: () => secret,
      terminal: { ...f.deps.terminal, readCode: async () => confirmationCode(secret) },
    });
    expectRefusal(await bootstrap.run(REQUEST).catch(() => ({ exitCode: 1 })));
    expect(await snapshot(db)).toEqual(before);
    expect(f.bindings).toEqual([]);
  },
);
