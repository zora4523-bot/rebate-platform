// B1-02zo 编排 §9.2 #1 / §9.3: the users columns that the session-time check (BR-WDR-01 细则,
// 07_WDR 123–135) reads and overwrites: last activity, last login device, the pending flag time,
// the trusted-identity snapshot and the per-account failure counter with its +08:00 day.
// Top-level it() only; each test preflights the column contract first.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CHECK_VIOLATION,
  NOT_NULL_VIOLATION,
  NO_ERROR,
  close,
  expectUserColumns,
  hash,
  open,
  person,
  reverifyState,
  sqlState,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open();
}, 180_000);
afterAll(async () => {
  await close(h);
});

const EMPTY = {
  last_active_at: null,
  last_login_device_hash: null,
  reverify_flagged_at: null,
  reverify_trusted: null,
  reverify_fail_count: 0,
  reverify_fail_day: null,
};

it('[AC-B1-02zo#1] users 新增六列的类型、可空性与默认值符合存储表；只写既有列的用户行取 fail_count 0、其余 NULL', async () => {
  await expectUserColumns(h.app);
  const owner = await person(h.app);
  expect(await reverifyState(h.app, owner.user_id)).toEqual(EMPTY);
});

it('[AC-B1-02zo#2] reverify_fail_count 由 CHECK 限定 ≥ 0、不可为 NULL；拒绝后行不变', async () => {
  await expectUserColumns(h.app);
  const owner = await person(h.app);
  const set = (value: number | null) =>
    sql`UPDATE app.users SET reverify_fail_count = ${value} WHERE id = ${owner.user_id}`.execute(
      h.app,
    );
  for (const value of [0, 1, 4, 5, 2_147_483_647]) {
    expect(await sqlState(set(value)), String(value)).toBe(NO_ERROR);
    expect((await reverifyState(h.app, owner.user_id))['reverify_fail_count']).toBe(value);
  }
  expect(await sqlState(set(3))).toBe(NO_ERROR);
  for (const value of [-1, -5, -2_147_483_648]) {
    expect(await sqlState(set(value)), String(value)).toBe(CHECK_VIOLATION);
  }
  expect(await sqlState(set(null))).toBe(NOT_NULL_VIOLATION);
  expect(await reverifyState(h.app, owner.user_id)).toEqual({ ...EMPTY, reverify_fail_count: 3 });

  // The CHECK also guards inserts, not only updates.
  const inserted = sql`INSERT INTO app.users
      (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method,
       reverify_fail_count)
    VALUES (gen_random_uuid(), ${owner.app_id}, 'fixture', 'fixture', md5(random()::text),
      md5(random()::text), 'L1', 'phone', -1)`.execute(h.app);
  expect(await sqlState(inserted)).toBe(CHECK_VIOLATION);
});

it('[AC-B1-02zo#3] couli_app 可写入并读回打标、可信身份快照、失败计数与日切日期，也可清回 NULL / 0', async () => {
  await expectUserColumns(h.app);
  const owner = await person(h.app);
  const active = new Date('2026-08-01T01:02:03.456Z');
  const flagged = new Date('2026-11-01T15:59:59.999Z');
  const device = hash();
  const trusted = { realname: true, providers: ['wechat', 'apple'] };
  const write = await sql`UPDATE app.users SET
      last_active_at = ${active}, last_login_device_hash = ${device},
      reverify_flagged_at = ${flagged}, reverify_trusted = ${JSON.stringify(trusted)}::jsonb,
      reverify_fail_count = 4, reverify_fail_day = ${'2026-11-02'}::date
    WHERE id = ${owner.user_id}`.execute(h.app);
  expect(write.numAffectedRows).toBe(1n);
  expect(await reverifyState(h.app, owner.user_id)).toEqual({
    last_active_at: active,
    last_login_device_hash: device,
    reverify_flagged_at: flagged,
    reverify_trusted: trusted,
    reverify_fail_count: 4,
    reverify_fail_day: '2026-11-02',
  });

  // A snapshot with no real-name and no third-party identities is still a snapshot (not NULL).
  const none = { realname: false, providers: [] };
  await sql`UPDATE app.users SET reverify_trusted = ${JSON.stringify(none)}::jsonb
    WHERE id = ${owner.user_id}`.execute(h.app);
  expect((await reverifyState(h.app, owner.user_id))['reverify_trusted']).toEqual(none);

  // Deletion processing (B1-02zr) clears everything back to the empty state.
  await sql`UPDATE app.users SET
      last_active_at = NULL, last_login_device_hash = NULL, reverify_flagged_at = NULL,
      reverify_trusted = NULL, reverify_fail_count = 0, reverify_fail_day = NULL
    WHERE id = ${owner.user_id}`.execute(h.app);
  expect(await reverifyState(h.app, owner.user_id)).toEqual(EMPTY);
});
