// B1-03zc §9.2 / §9.3 (规划/08 BR-ID-25, BR-ID-26; D10-443 (b)): identity's batch minor-status port
// for settlement's BeneficiaryGate. Who is in the set, app isolation, de-duplication, the caller's
// transaction, read-only behaviour and the broken-database refusals. Age boundaries and the
// identification instant are in boundary.int.test.ts.
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, expectTypeOf, it, vi } from 'vitest';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type { MinorStatusReader } from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import {
  ADULT_BIRTH,
  AT,
  CONTEXT,
  MINOR_BIRTH,
  normalized,
  observe,
  openCrypto,
  person,
  realname,
  user,
  watchDecrypt,
} from './kit.ts';

// Intercept the sanctioned application logger, child bindings included (same as the other
// identity reader suites): the port has no logger option, and must not log at all.
const logging = vi.hoisted(() => {
  const write = vi.fn();
  const logger = {
    trace: write,
    debug: write,
    info: write,
    warn: write,
    error: write,
    fatal: write,
    child: vi.fn(),
  };
  logger.child.mockImplementation((...args: unknown[]) => {
    write(...args);
    return logger;
  });
  return { write, logger };
});
vi.mock('../../../../apps/api/src/modules/platform/logging/logger.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createRootLogger: vi.fn(() => logging.logger) };
});

// The public index export at run time; the URL import keeps Nest decorators out of the test TS
// project (same as the other identity port suites). The type query is erased.
const { createMinorStatusBatchReader } = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/identity/ports/minor-status-batch.ts');

let database: TestDatabase | undefined;
let db: Kysely<DB>;
let other: Kysely<DB>;
let crypto: FieldCrypto;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
  other = createDb({ connectionString: database.urlFor('couli_app') });
  crypto = await openCrypto();
});
afterAll(async () => {
  try {
    await Promise.all([db && destroyDb(db), other && destroyDb(other)]);
  } finally {
    await database?.drop();
  }
});

function appId(): string {
  return `synthetic_minor_${randomUUID()}`;
}

/** What the read settled with: the rejection reason, or the resolved value. */
async function settle(run: Promise<unknown>): Promise<{ rejected: boolean; value: unknown }> {
  return run.then(
    (value) => ({ rejected: false, value }),
    (value: unknown) => ({ rejected: true, value }),
  );
}

/** The read rejected with an Error that is not the skeleton's and carries no private value. */
function expectBrokenRecord(
  outcome: { rejected: boolean; value: unknown },
  secrets: readonly string[],
): void {
  expect(outcome.rejected).toBe(true);
  expect(outcome.value).toBeInstanceOf(Error);
  const printed = inspect(outcome.value, { showHidden: true, depth: null });
  expect(printed).not.toContain('NotImplemented');
  for (const secret of secrets) expect(printed).not.toContain(secret);
}

it('[AC-B1-03zc#1][BR-ID-26] 只有已实名且未满 18 周岁的请求用户在集合内', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  const app = appId();
  const minor = await person(db, crypto, app, { birth: MINOR_BIRTH });
  const adult = await person(db, crypto, app, { birth: ADULT_BIRTH });
  const noRow = await person(db, crypto, app, null);
  const none = await person(db, crypto, app, { status: 'none' });
  const failed = await person(db, crypto, app, { status: 'failed' });
  // A cleared record keeps its ciphers for tax (status none, tax_retained): still not verified.
  const retained = await person(db, crypto, app, { status: 'none', taxRetained: true });
  const unrequested = await person(db, crypto, app, { birth: MINOR_BIRTH });
  const missing = randomUUID();
  const userIds = Object.freeze([minor, adult, noRow, none, failed, retained, missing]);
  const before = [...userIds];
  const result = await reader.read(db, { appId: app, userIds, at: AT });
  expectTypeOf(result).toEqualTypeOf<ReadonlySet<string>>();
  expect(result).toEqual(new Set([minor]));
  expect(result.has(unrequested)).toBe(false);
  expect(userIds).toEqual(before);
});

it('[AC-B1-03zc#2][BR-ID-26] 同一 user_id 只在自己的 app 下可见，交错读取不串应用', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  const owner = appId();
  const foreign = appId();
  const mine = await person(db, crypto, owner, { birth: MINOR_BIRTH });
  const theirs = await person(db, crypto, foreign, { birth: MINOR_BIRTH });
  const userIds = [mine, theirs];
  expect(await reader.read(db, { appId: owner, userIds, at: AT })).toEqual(new Set([mine]));
  expect(await reader.read(db, { appId: foreign, userIds, at: AT })).toEqual(new Set([theirs]));
  expect(await reader.read(db, { appId: owner, userIds: [theirs], at: AT })).toEqual(new Set());
  expect(await reader.read(db, { appId: appId(), userIds, at: AT })).toEqual(new Set());
  expect(await reader.read(db, { appId: owner, userIds, at: AT })).toEqual(new Set([mine]));
});

it('[AC-B1-03zc#3][BR-ID-26] 重复 id 只算一次，每条 SQL 里每个 id 只绑定一次', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  const app = appId();
  const a = await person(db, crypto, app, { birth: MINOR_BIRTH });
  const b = await person(db, crypto, app, { birth: MINOR_BIRTH });
  const c = await person(db, crypto, app, { birth: ADULT_BIRTH });
  const caller = observe(db);
  const userIds = Object.freeze([b, a, c, b, a, b, c]);
  const result = await reader.read(caller.executor, { appId: app, userIds, at: AT });
  expect(result).toEqual(new Set([a, b]));
  expect(result.size).toBe(2);
  expect(caller.statements.length).toBeGreaterThan(0);
  for (const statement of caller.statements) {
    const bound = statement.parameters.flat().map(String);
    for (const id of [a, b, c]) {
      expect(bound.filter((value) => value === id).length).toBeLessThanOrEqual(1);
    }
  }
});

it('[AC-B1-03zc#4][BR-ID-26] 空 userIds 返回空集，不查库、不解密', async () => {
  const watched = watchDecrypt(crypto);
  const reader = createMinorStatusBatchReader({ crypto: watched.crypto });
  const caller = observe(db);
  const result = await reader.read(caller.executor, { appId: appId(), userIds: [], at: AT });
  expect(result).toEqual(new Set());
  expect(caller.statements).toEqual([]);
  expect(watched.contexts).toEqual([]);
});

it('[AC-B1-03zc#5][BR-ID-26] 形状可直接当 settlement BeneficiaryGate 的 MinorStatusReader 用', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  // Compile-time: the port is assignable to the gate's declared reader.
  const minors: MinorStatusReader = reader;
  const app = appId();
  const minor = await person(db, crypto, app, { birth: MINOR_BIRTH });
  const adult = await person(db, crypto, app, { birth: ADULT_BIRTH });
  const result = await db
    .transaction()
    .execute((trx) => minors.read(trx, { appId: app, userIds: [adult, minor], at: AT }));
  expect(result).toEqual(new Set([minor]));
});

it('[AC-B1-03zc#6][BR-ID-26] 在调用方事务上读：未提交的实名插入与更新可见，回滚后消失', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  const app = appId();
  const rollback = new Error('synthetic rollback');
  let id = '';
  await expect(
    db.transaction().execute(async (trx) => {
      id = await person(trx, crypto, app, { birth: MINOR_BIRTH });
      const input = { appId: app, userIds: [id], at: AT };
      expect(await reader.read(other, input)).toEqual(new Set());
      expect(await reader.read(trx, input)).toEqual(new Set([id]));
      // An uncommitted later identification is seen on the same transaction too.
      await trx
        .withSchema('app')
        .updateTable('realname')
        .set({ verified_at: new Date(AT.getTime() + 1) })
        .where('app_id', '=', app)
        .where('user_id', '=', id)
        .execute();
      expect(await reader.read(trx, input)).toEqual(new Set());
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await reader.read(db, { appId: app, userIds: [id], at: AT })).toEqual(new Set());
});

it('[AC-B1-03zc#7][BR-ID-26] 不缓存：同一 reader 立即反映已提交的实名变化', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  const app = appId();
  const id = await user(db, app);
  const input = { appId: app, userIds: [id], at: AT };
  expect(await reader.read(db, input)).toEqual(new Set());
  await realname(db, crypto, app, id, { birth: MINOR_BIRTH });
  expect(await reader.read(db, input)).toEqual(new Set([id]));
  await db
    .withSchema('app')
    .updateTable('realname')
    .set({
      status: 'failed',
      name_cipher: null,
      id_no_cipher: null,
      id_no_hmac: null,
      birth_date_cipher: null,
    })
    .where('app_id', '=', app)
    .where('user_id', '=', id)
    .execute();
  expect(await reader.read(db, input)).toEqual(new Set());
});

it('[AC-B1-03zc#8][BR-ID-26] 只读不加锁：只读事务内可用，不写不锁，表内容不变', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  const app = appId();
  const minor = await person(db, crypto, app, { birth: MINOR_BIRTH });
  const adult = await person(db, crypto, app, { birth: ADULT_BIRTH });
  const snapshot = async () => ({
    users: await db
      .withSchema('app')
      .selectFrom('users')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    realname: await db
      .withSchema('app')
      .selectFrom('realname')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
  });
  const lockable = (id: string) =>
    other.transaction().execute(async (trx) => {
      // Each probe owns its transaction: a NOWAIT failure cannot abort the reader's.
      const users = await sql`SELECT id FROM app.users WHERE app_id = ${app} AND id = ${id}
        FOR UPDATE NOWAIT`.execute(trx);
      const rows = await sql`SELECT id FROM app.realname WHERE app_id = ${app} AND user_id = ${id}
        FOR UPDATE NOWAIT`.execute(trx);
      return users.rows.length + rows.rows.length;
    });
  const before = await snapshot();
  await db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      const caller = observe(trx);
      expect(
        await reader.read(caller.executor, { appId: app, userIds: [minor, adult], at: AT }),
      ).toEqual(new Set([minor]));
      expect(caller.statements.length).toBeGreaterThan(0);
      for (const statement of caller.statements) {
        const query = normalized(statement);
        expect(query).not.toMatch(/\b(?:insert|update|delete|merge|lock)\b/);
        expect(query).not.toMatch(/\bfor\s+(?:update|share|key|no)\b/);
        // Only the birth date is needed: the name and the ID number are never read.
        expect(query).not.toMatch(/\b(?:name_cipher|id_no_cipher|id_no_hmac)\b/);
      }
      // A swallowed error must not leave an aborted transaction behind.
      expect((await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx)).rows).toEqual([{ ok: 1 }]);
      expect(await lockable(minor)).toBe(2);
      expect(await lockable(adult)).toBe(2);
    });
  expect(await snapshot()).toEqual(before);
});

it('[AC-B1-03zc#9][BR-ID-25] 只按 realname.birth_date 域解密出生日期，不解密姓名与证件号', async () => {
  const watched = watchDecrypt(crypto);
  const reader = createMinorStatusBatchReader({ crypto: watched.crypto });
  const app = appId();
  const minor = await person(db, crypto, app, { birth: MINOR_BIRTH });
  const adult = await person(db, crypto, app, { birth: ADULT_BIRTH });
  expect(await reader.read(db, { appId: app, userIds: [minor, adult], at: AT })).toEqual(
    new Set([minor]),
  );
  expect(watched.contexts.length).toBeGreaterThan(0);
  expect(new Set(watched.contexts)).toEqual(new Set([CONTEXT.birthDate]));
});

it('[AC-B1-03zc#10][BR-ID-26] 集合只含请求的 user_id，不带出生日期；各分支都不写应用日志', async () => {
  const app = appId();
  const minor = await person(db, crypto, app, { birth: MINOR_BIRTH });
  const adult = await person(db, crypto, app, { birth: ADULT_BIRTH });
  const failed = await person(db, crypto, app, { status: 'failed' });
  logging.write.mockClear();
  const reader = createMinorStatusBatchReader({ crypto });
  const results: ReadonlySet<string>[] = [];
  await db.transaction().execute(async (trx) => {
    for (const input of [
      { appId: app, userIds: [minor, adult, failed] },
      { appId: app, userIds: [randomUUID()] },
      { appId: appId(), userIds: [minor] },
      { appId: app, userIds: [] },
    ]) {
      results.push(await reader.read(trx, { ...input, at: AT }));
    }
  });
  expect(results).toEqual([new Set([minor]), new Set(), new Set(), new Set()]);
  for (const value of results[0] ?? []) expect(typeof value).toBe('string');
  const printed = inspect(results, { showHidden: true, depth: null });
  for (const secret of [MINOR_BIRTH, ADULT_BIRTH]) expect(printed).not.toContain(secret);
  expect(logging.write).not.toHaveBeenCalled();
});

it('[AC-B1-03zc#11][BR-ID-25] 坏库：verified 行的出生日期密文不可解密时整批拒绝，不返回集合', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  const app = appId();
  const good = await person(db, crypto, app, { birth: MINOR_BIRTH });
  expect(await reader.read(db, { appId: app, userIds: [good], at: AT })).toEqual(new Set([good]));
  const garbage = await person(db, crypto, app, {
    birthCipher: Buffer.from('synthetic-not-a-ciphertext'),
  });
  const empty = await person(db, crypto, app, { birthCipher: Buffer.alloc(0) });
  for (const bad of [garbage, empty]) {
    expectBrokenRecord(
      await settle(reader.read(db, { appId: app, userIds: [good, bad], at: AT })),
      [MINOR_BIRTH, '合成姓名', `synthetic-id-${bad}`],
    );
  }
  // Rows that were not requested do not poison the batch.
  expect(await reader.read(db, { appId: app, userIds: [good], at: AT })).toEqual(new Set([good]));
});

it('[AC-B1-03zc#12][BR-ID-25] 坏库：出生日期按别的域加密（解不开）时拒绝，错误不含出生日期', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  const app = appId();
  const good = await person(db, crypto, app, { birth: MINOR_BIRTH });
  const bad = await person(db, crypto, app, {
    birthCipher: Buffer.from(crypto.encrypt(MINOR_BIRTH, CONTEXT.idNo)),
  });
  expect(await reader.read(db, { appId: app, userIds: [good], at: AT })).toEqual(new Set([good]));
  expectBrokenRecord(await settle(reader.read(db, { appId: app, userIds: [bad], at: AT })), [
    MINOR_BIRTH,
    '合成姓名',
    `synthetic-id-${bad}`,
  ]);
});

it.each([
  ['不存在的日期', '2010-02-30'],
  ['格式不是 YYYY-MM-DD', '20100515'],
  ['不是日期', 'synthetic-birth'],
])(
  '[AC-B1-03zc#13][BR-ID-25] 坏库：解密出的出生日期非法（%s）时拒绝，不当成年放过也不当未成年吞掉',
  async (_label, birth) => {
    const reader = createMinorStatusBatchReader({ crypto });
    const app = appId();
    const good = await person(db, crypto, app, { birth: MINOR_BIRTH });
    const bad = await person(db, crypto, app, { birth });
    expect(await reader.read(db, { appId: app, userIds: [good], at: AT })).toEqual(new Set([good]));
    expectBrokenRecord(
      await settle(reader.read(db, { appId: app, userIds: [good, bad], at: AT })),
      [birth, MINOR_BIRTH, '合成姓名', `synthetic-id-${bad}`],
    );
  },
);
