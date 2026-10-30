// B1-03zc §9.2 #3, §9.3 (规划/08 BR-ID-26): the instant one turns 18 is 00:00 +08:00 on the day after
// the 18th birthday; someone born on 29 February has the birthday on 1 March in a non-leap year
// (so turns 18 at 2 March 00:00 +08:00). From that instant on the user is no longer a minor. The
// identification instant is realname's verified_at: identified later than `at` → not in the set.
// Every instant below is written by hand in UTC (00:00 +08:00 = 16:00Z of the previous day).
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { ADULT_BIRTH, AT, MINOR_BIRTH, openCrypto, person } from './kit.ts';

// The public index export at run time (see reader.int.test.ts); the type query is erased.
const { createMinorStatusBatchReader } = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/identity/ports/minor-status-batch.ts');

let database: TestDatabase | undefined;
let db: Kysely<DB>;
let crypto: FieldCrypto;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
  crypto = await openCrypto();
});
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

function appId(): string {
  return `synthetic_minor_age_${randomUUID()}`;
}

/** Identified long before every `at` below. */
const EARLY = new Date('2025-06-01T00:00:00.000Z');

// [label (times +08:00), birth date, at (UTC), still a minor at `at`]
const CASES: [string, string, string, boolean][] = [
  // 18th birthday 2026-10-30; turns 18 at 2026-10-31 00:00 +08:00 = 2026-10-30T16:00Z.
  ['生日当天 00:00', '2008-10-30', '2026-10-29T16:00:00.000Z', true],
  ['生日当天 23:59:59.999', '2008-10-30', '2026-10-30T15:59:59.999Z', true],
  ['生日次日 00:00', '2008-10-30', '2026-10-30T16:00:00.000Z', false],
  ['生日次日 08:00（UTC 零点）', '2008-10-30', '2026-10-31T00:00:00.000Z', false],
  // Born 2008-02-29; 2026 is not a leap year: birthday 03-01, turns 18 at 03-02 00:00 +08:00.
  ['2-29 生，2-28 23:59:59.999', '2008-02-29', '2026-02-28T15:59:59.999Z', true],
  ['2-29 生，3-1 00:00', '2008-02-29', '2026-02-28T16:00:00.000Z', true],
  ['2-29 生，3-1 23:59:59.999', '2008-02-29', '2026-03-01T15:59:59.999Z', true],
  ['2-29 生，3-2 00:00', '2008-02-29', '2026-03-01T16:00:00.000Z', false],
  // Across the year end: born 2008-12-31, turns 18 at 2027-01-01 00:00 +08:00.
  ['12-31 生，生日当天 23:59:59.999', '2008-12-31', '2026-12-31T15:59:59.999Z', true],
  ['12-31 生，次年 1-1 00:00', '2008-12-31', '2026-12-31T16:00:00.000Z', false],
  // Inside the 14–18 band and far from it.
  ['满 14 未满 18', '2012-05-15', '2026-10-30T04:00:00.000Z', true],
  ['76 岁', '1949-12-31', '2026-10-30T04:00:00.000Z', false],
];

it.each(CASES)('[AC-B1-03zc#14][BR-ID-26] 满 18 周岁边界：%s', async (_label, birth, at, minor) => {
  const reader = createMinorStatusBatchReader({ crypto });
  const app = appId();
  const id = await person(db, crypto, app, { birth, verifiedAt: EARLY });
  const result = await reader.read(db, { appId: app, userIds: [id], at: new Date(at) });
  expect(result).toEqual(minor ? new Set([id]) : new Set());
});

it('[AC-B1-03zc#15][BR-ID-26] 同一批里按各自出生日期判定，同一 at 下边界两侧分开', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  const app = appId();
  // at = 2026-10-30T16:00Z = 2026-10-31 00:00 +08:00.
  const at = new Date('2026-10-30T16:00:00.000Z');
  const turnedToday = await person(db, crypto, app, { birth: '2008-10-30', verifiedAt: EARLY });
  const turnsTomorrow = await person(db, crypto, app, { birth: '2008-10-31', verifiedAt: EARLY });
  const leapDay = await person(db, crypto, app, { birth: '2008-02-29', verifiedAt: EARLY });
  const young = await person(db, crypto, app, { birth: MINOR_BIRTH, verifiedAt: EARLY });
  const adult = await person(db, crypto, app, { birth: ADULT_BIRTH, verifiedAt: EARLY });
  const userIds = [turnedToday, turnsTomorrow, leapDay, young, adult];
  expect(await reader.read(db, { appId: app, userIds, at })).toEqual(
    new Set([turnsTomorrow, young]),
  );
  // One millisecond earlier the user born 2008-10-30 is still 17.
  expect(await reader.read(db, { appId: app, userIds, at: new Date(at.getTime() - 1) })).toEqual(
    new Set([turnedToday, turnsTomorrow, young]),
  );
});

it('[AC-B1-03zc#16][BR-ID-26] 识别时刻：verified_at 晚于 at 不在集合，等于或早于 at 在', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  const app = appId();
  const later = await person(db, crypto, app, {
    birth: MINOR_BIRTH,
    verifiedAt: new Date(AT.getTime() + 1),
  });
  const equal = await person(db, crypto, app, { birth: MINOR_BIRTH, verifiedAt: AT });
  const earlier = await person(db, crypto, app, {
    birth: MINOR_BIRTH,
    verifiedAt: new Date(AT.getTime() - 1),
  });
  const adultEarlier = await person(db, crypto, app, { birth: ADULT_BIRTH, verifiedAt: EARLY });
  const userIds = [later, equal, earlier, adultEarlier];
  expect(await reader.read(db, { appId: app, userIds, at: AT })).toEqual(new Set([equal, earlier]));
  // The same records at a later instant: the later identification now counts too.
  expect(await reader.read(db, { appId: app, userIds, at: new Date(AT.getTime() + 1) })).toEqual(
    new Set([later, equal, earlier]),
  );
  // Before any of them was identified, nobody is in the set.
  expect(await reader.read(db, { appId: app, userIds, at: new Date(AT.getTime() - 2) })).toEqual(
    new Set(),
  );
});

it('[AC-B1-03zc#17][BR-ID-26] 识别后满 18：识别时未成年、at 时已满 18 的不在集合', async () => {
  const reader = createMinorStatusBatchReader({ crypto });
  const app = appId();
  // Identified at 17 (2026-01-01), turns 18 at 2026-10-30T16:00Z.
  const id = await person(db, crypto, app, {
    birth: '2008-10-30',
    verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const input = { appId: app, userIds: [id] };
  expect(await reader.read(db, { ...input, at: new Date('2026-10-30T15:59:59.999Z') })).toEqual(
    new Set([id]),
  );
  expect(await reader.read(db, { ...input, at: new Date('2026-10-30T16:00:00.000Z') })).toEqual(
    new Set(),
  );
});
