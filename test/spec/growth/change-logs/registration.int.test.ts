// B1-11b register-time level log (BR-INV-14: same transaction, source=register, before NULL,
// after level.default, effective_at = created_at): createRegistrationService with the
// recordInitialLevel that identity's adapter builds over the port app.module wires to growth
// (from_level null, source register, operator system, reason null).
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely, Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type {
  InitialLevelLog,
  InitialLevelLogEntry,
} from '../../../../apps/api/src/modules/identity/application/initial-level-log.ts';
import type {
  RegistrationOptions,
  RegistrationResult,
} from '../../../../apps/api/src/modules/identity/application/registration.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  attempt,
  capturedLogger,
  levelLogs,
  newAppId,
  rolledBack,
  shift,
  userCount,
  userCreatedAt,
  userSnapshot,
} from './kit.ts';

const growth = await import('../../../../apps/api/src/modules/growth/index.ts');
const { createRecordInitialLevel } =
  await import('../../../../apps/api/src/modules/identity/application/initial-level-log.ts');
const { createRegistrationService } =
  await import('../../../../apps/api/src/modules/identity/application/registration.ts');
const { FixedClock } = await import('../../../../apps/api/src/modules/platform/clock/index.ts');
const { createWrappedKeyring, LocalKeyProvider, openFieldCrypto } =
  await import('../../../../apps/api/src/modules/platform/crypto/index.ts');

let database: TestDatabase | undefined;
let db: Kysely<DB>;
let crypto: FieldCrypto;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  const provider = new LocalKeyProvider(randomBytes(32));
  crypto = await openFieldCrypto(await createWrappedKeyring(provider), provider);
});

afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

/** The port as app.module wires it (B1-11b §9.3 item 5). */
function growthPort(): InitialLevelLog {
  return {
    append: (trx, entry) =>
      growth.appendLevelChange(trx, {
        ...entry,
        from_level: null,
        source: 'register',
        operator: 'system',
        reason: null,
      }),
  };
}

function setup(level?: 'L1' | 'L3') {
  const app = newAppId();
  const clock = new FixedClock('2026-10-20T02:00:00.123Z');
  const { logger } = capturedLogger();
  const options: RegistrationOptions = {
    clock,
    crypto,
    logger,
    config: {
      configValue: (_app, key) =>
        Promise.resolve(
          key === 'level.default' && level !== undefined ? { value: level, version: 1 } : null,
        ),
    },
    sensitiveWords: { matches: () => false },
  };
  const command = {
    app_id: app,
    phone: `139${String(randomInt(100_000_000)).padStart(8, '0')}`,
    register_method: 'sms' as const,
    device_hash: randomBytes(32).toString('hex'),
    device_id: randomUUID(),
    client_ip: '192.0.2.40',
  };
  return { app, clock, options, command };
}

function created(result: RegistrationResult): string {
  expect(result).toMatchObject({ code: 0 });
  if (!('code' in result) || result.code !== 0) throw new Error('unreachable after assertion');
  return result.user_id;
}

for (const [n, level] of [
  [20, 'L1'],
  [21, 'L3'],
] as const) {
  it(`[AC-B1-11b#${String(n)}] level.default=${level} 建号：恰一条 register 日志，from_level 为空、effective_at = users.created_at、operator=system；levelAt 在 created_at 取到 ${level}，早 1ms 走 L1 兜底`, async () => {
    const recordInitialLevel = createRecordInitialLevel(growthPort());
    const { app, clock, options, command } = setup(level === 'L1' ? undefined : level);
    const service = createRegistrationService({ ...options, recordInitialLevel });
    const user = created(await db.transaction().execute((trx) => service.register(trx, command)));
    const createdAt = await userCreatedAt(db, user);
    expect(createdAt.getTime()).toBe(clock.now().getTime());
    const rows = await levelLogs(db, app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      app_id: app,
      user_id: user,
      from_level: null,
      to_level: level,
      source: 'register',
      operator: 'system',
      reason: null,
    });
    expect(rows[0]!.effective_at.getTime()).toBe(createdAt.getTime());
    // growth wrote no users column: the level is what registration stored, no parent.
    expect(await userSnapshot(db, user)).toMatchObject({ level, parent_id: null });

    const history = growth.createGrowthHistory({ logger: capturedLogger().logger });
    expect(await history.levelAt(db, { app_id: app, user_id: user, at: createdAt })).toEqual({
      level,
      missing: false,
    });
    expect(
      await history.levelAt(db, { app_id: app, user_id: user, at: shift(createdAt, -1) }),
    ).toEqual({ level: 'L1', missing: true });
  });
}

it('[AC-B1-11b#22] 适配器在建号事务里调端口一次，传同一事务与 { app_id, user_id, to_level, effective_at = users.created_at }', async () => {
  const seen: { trx: Transaction<DB>; entry: InitialLevelLogEntry; createdAt: Date }[] = [];
  const append = vi.fn<InitialLevelLog['append']>(async (trx, entry) => {
    seen.push({ trx, entry, createdAt: await userCreatedAt(trx, entry.user_id) });
  });
  const recordInitialLevel = createRecordInitialLevel({ append });
  const { app, options, command } = setup('L3');
  const service = createRegistrationService({ ...options, recordInitialLevel });
  let outer: Transaction<DB> | undefined;
  const user = created(
    await db.transaction().execute((trx) => {
      outer = trx;
      return service.register(trx, command);
    }),
  );
  expect(append).toHaveBeenCalledTimes(1);
  expect(seen[0]!.trx).toBe(outer);
  expect(seen[0]!.entry).toEqual({
    app_id: app,
    user_id: user,
    to_level: 'L3',
    effective_at: seen[0]!.createdAt,
  });
  expect(seen[0]!.entry.effective_at.getTime()).toBe((await userCreatedAt(db, user)).getTime());
});

it('[AC-B1-11b#23] 建号回滚时注册等级日志一起没有：端口写入后后续步骤失败（50001），或调用方回滚', async () => {
  const failing = createRecordInitialLevel({
    append: async (trx, entry) => {
      await growthPort().append(trx, entry);
      throw new Error('a later step of the creation failed');
    },
  });
  const first = setup();
  const service = createRegistrationService({ ...first.options, recordInitialLevel: failing });
  expect(await db.transaction().execute((trx) => service.register(trx, first.command))).toEqual({
    code: 50001,
  });
  expect(await userCount(db, first.app)).toBe(0);
  expect(await levelLogs(db, first.app)).toEqual([]);

  const second = setup('L3');
  const wired = createRegistrationService({
    ...second.options,
    recordInitialLevel: createRecordInitialLevel(growthPort()),
  });
  await rolledBack(db, async (trx) => {
    created(await wired.register(trx, second.command));
    expect(await levelLogs(trx, second.app)).toHaveLength(1);
  });
  expect(await userCount(db, second.app)).toBe(0);
  expect(await levelLogs(db, second.app)).toEqual([]);
});

it('[AC-B1-11b#24] 适配器读不到本账号 users 行：抛错且不调端口', async () => {
  const append = vi.fn<InitialLevelLog['append']>(async () => undefined);
  const recordInitialLevel = createRecordInitialLevel({ append });
  const app = newAppId();
  await rolledBack(db, async (trx) => {
    const outcome = attempt(() =>
      recordInitialLevel(trx, {
        app_id: app,
        user_id: randomUUID(),
        level: 'L2',
        source: 'register',
      }),
    );
    await expect(outcome).rejects.toBeInstanceOf(Error);
    await expect(outcome).rejects.not.toThrow(/NotImplemented/);
  });
  expect(append).not.toHaveBeenCalled();
});
