// B3-03d 第 9 节 7：会话存取（真 PostgreSQL，createTestDatabase，业务角色 couli_app）。建会话写
// agent_sessions（登录用户 user_id，游客 device_id 且 user_id 为空）；current 只返回本人最近未过期的会话
// （last_active_at + 24 小时 > now 为未过期，BR-AI-20）；登录后看不到游客会话；别人的会话 id 在 ④ 得 null
// （HTTP 层据此返回 30504）；run 归属判断供取消接口用。时间只取注入的 Clock。
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createPgAgentSessionStore,
  type AgentOwner,
  type AgentSessionStore,
} from '../../../../apps/api/src/modules/agent/store/index.ts';
import { connect, insertRow, newUser } from '../../db/linking-bindings/kit.ts';
import { APP, IDLE_MS, START_MS, type Row } from './kit.ts';

let database: TestDatabase | undefined;
let pool: Kysely<DB> | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  connect(pool);
}, 180_000);

afterAll(async () => {
  if (pool) await destroyDb(pool);
  if (database) await database.drop();
});

function db(): Kysely<DB> {
  expect(pool, 'database ready').toBeDefined();
  return pool!;
}

/** A clock the test moves (ms since START_MS). */
class TestClock implements Clock {
  ms = START_MS;
  now(): Date {
    return new Date(this.ms);
  }
}

function store(clock: Clock): AgentSessionStore {
  return createPgAgentSessionStore({ db: db(), clock, idleMs: IDLE_MS });
}

async function newDevice(): Promise<string> {
  const id = randomUUID();
  await insertRow('devices', {
    id,
    app_id: APP,
    user_id: null,
    install_secret_cipher: Buffer.from('synthetic-install-secret'),
    last_seen_at: new Date(START_MS - 3 * IDLE_MS),
  });
  return id;
}

async function deviceOwner(): Promise<AgentOwner> {
  return { kind: 'device', appId: APP, deviceId: await newDevice() };
}

async function userOwner(deviceId?: string): Promise<AgentOwner> {
  return {
    kind: 'user',
    appId: APP,
    userId: await newUser(),
    deviceId: deviceId ?? (await newDevice()),
  };
}

/** A session row written directly for `owner`, last active at `lastActiveMs`. */
async function seedSession(owner: AgentOwner, lastActiveMs: number): Promise<string> {
  const id = randomUUID();
  const at = new Date(lastActiveMs);
  await sql`INSERT INTO app.agent_sessions (id, app_id, user_id, device_id, started_at, last_active_at)
    VALUES (${id}, ${APP}, ${owner.kind === 'user' ? owner.userId : null}, ${owner.deviceId},
      ${new Date(lastActiveMs - 60_000)}, ${at})`.execute(db());
  return id;
}

async function seedRun(sessionId: string, acceptedMs: number): Promise<string> {
  const id = randomUUID();
  const at = new Date(acceptedMs);
  await sql`INSERT INTO app.agent_runs
    (id, app_id, session_id, accepted_at, quota_subjects, prompt_version, deadline_at)
    VALUES (${id}, ${APP}, ${sessionId}, ${at}, ${['["device","synthetic"]']}, 'synthetic@1',
      ${new Date(acceptedMs + 20_000)})`.execute(db());
  return id;
}

async function sessionRows(owner: AgentOwner): Promise<Row[]> {
  const q =
    owner.kind === 'user'
      ? sql<Row>`SELECT * FROM app.agent_sessions WHERE app_id = ${APP} AND user_id = ${owner.userId}`
      : sql<Row>`SELECT * FROM app.agent_sessions WHERE app_id = ${APP} AND user_id IS NULL
          AND device_id = ${owner.deviceId}`;
  return (await q.execute(db())).rows;
}

async function count(table: 'agent_runs' | 'agent_messages', sessionId: string): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(`app.${table}`)}
    WHERE app_id = ${APP} AND session_id = ${sessionId}`.execute(db());
  return r.rows[0]!.n;
}

it('[AC-B3-03d#27] open：游客写 user_id 为空、device_id 为本设备；登录用户写 user_id 与本次设备；started_at = last_active_at = 注入时钟的 now；不写 run 与消息', async () => {
  const clock = new TestClock();
  clock.ms = START_MS + 12_345;
  const s = store(clock);
  for (const owner of [await deviceOwner(), await userOwner()]) {
    const id = randomUUID();
    const row = await s.open(owner, id);
    expect(row.id).toBe(id);
    expect(row.startedAt.getTime()).toBe(clock.ms);
    expect(row.lastActiveAt.getTime()).toBe(clock.ms);
    const rows = await sessionRows(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      app_id: APP,
      user_id: owner.kind === 'user' ? owner.userId : null,
      device_id: owner.deviceId,
    });
    expect((rows[0]!['started_at'] as Date).getTime()).toBe(clock.ms);
    expect((rows[0]!['last_active_at'] as Date).getTime()).toBe(clock.ms);
    expect(await count('agent_runs', id)).toBe(0);
    expect(await count('agent_messages', id)).toBe(0);
  }
});

it('[AC-B3-03d#28] open 重复调用：最新的未过期会话还没有任何 run 时原样返回、不新建；有了 run 或已过期才新建', async () => {
  const clock = new TestClock();
  const s = store(clock);
  const owner = await userOwner();
  const first = await s.open(owner, randomUUID());
  const again = await s.open(owner, randomUUID());
  expect(again.id).toBe(first.id);
  expect(await sessionRows(owner)).toHaveLength(1);

  await seedRun(first.id, START_MS);
  const third = await s.open(owner, randomUUID());
  expect(third.id).not.toBe(first.id);
  expect(await sessionRows(owner)).toHaveLength(2);

  // The newest empty session expires: a new one is made.
  clock.ms = START_MS + IDLE_MS;
  const fourth = await s.open(owner, randomUUID());
  expect([first.id, third.id]).not.toContain(fourth.id);
  expect(await sessionRows(owner)).toHaveLength(3);
});

it('[AC-B3-03d#29] current：返回本人最近活跃的未过期会话；last_active_at + 24 小时 ≤ now 即过期；没有则 null；只读不改 last_active_at', async () => {
  const clock = new TestClock();
  const s = store(clock);
  const owner = await deviceOwner();
  expect(await s.current(owner)).toBeNull();
  const older = await seedSession(owner, START_MS - 3_600_000);
  const newer = await seedSession(owner, START_MS - 60_000);
  expect((await s.current(owner))?.id).toBe(newer);

  // 1 ms before the newer one expires it is still current; at the instant it is expired.
  clock.ms = START_MS - 60_000 + IDLE_MS - 1;
  expect((await s.current(owner))?.id).toBe(newer);
  clock.ms = START_MS - 60_000 + IDLE_MS;
  expect(await s.current(owner)).toBeNull();
  expect(older).not.toBe(newer);

  const rows = await sessionRows(owner);
  const byId = new Map(rows.map((r) => [r['id'], (r['last_active_at'] as Date).getTime()]));
  expect(byId.get(newer)).toBe(START_MS - 60_000);
  expect(byId.get(older)).toBe(START_MS - 3_600_000);
});

it('[AC-B3-03d#30] BR-AI-20 所有者：登录后看不到本设备的游客会话；游客看不到同设备上登录用户的会话；别的设备、别的用户互不可见', async () => {
  const s = store(new TestClock());
  const device = await deviceOwner();
  const user = await userOwner(device.deviceId);
  const guestSession = await seedSession(device, START_MS - 1_000);
  expect((await s.current(device))?.id).toBe(guestSession);
  expect(await s.current(user)).toBeNull();
  expect(await s.owned(user, guestSession)).toBeNull();

  const userSession = await seedSession(user, START_MS - 500);
  expect((await s.current(user))?.id).toBe(userSession);
  expect((await s.current(device))?.id).toBe(guestSession);
  expect(await s.owned(device, userSession)).toBeNull();

  // The same user on another device sees the session; another user and another device do not.
  const sameUser: AgentOwner = { ...user, deviceId: await newDevice() };
  expect((await s.current(sameUser))?.id).toBe(userSession);
  expect(await s.owned(await userOwner(device.deviceId), userSession)).toBeNull();
  expect(await s.owned(await deviceOwner(), guestSession)).toBeNull();
});

it('[AC-B3-03d#31] owned（④）：本人的会话给出 {session, expired}，过期边界同 current；不存在、别人的、非 UUID 的 id 一律 null 且不报错', async () => {
  const clock = new TestClock();
  const s = store(clock);
  const owner = await userOwner();
  const id = await seedSession(owner, START_MS - 60_000);
  const live = await s.owned(owner, id);
  expect(live?.session.id).toBe(id);
  expect(live?.expired).toBe(false);
  expect(live?.session.lastActiveAt.getTime()).toBe(START_MS - 60_000);

  clock.ms = START_MS - 60_000 + IDLE_MS - 1;
  expect((await s.owned(owner, id))?.expired).toBe(false);
  clock.ms = START_MS - 60_000 + IDLE_MS;
  const expired = await s.owned(owner, id);
  expect(expired?.session.id).toBe(id);
  expect(expired?.expired).toBe(true);

  expect(await s.owned(owner, randomUUID())).toBeNull();
  expect(await s.owned(await userOwner(), id)).toBeNull();
  expect(await s.owned(owner, 'not-a-uuid')).toBeNull();
  expect(await s.owned(owner, '')).toBeNull();
});

it('[AC-B3-03d#32] ownsRun（取消接口）：run 在本人会话里为 true（会话过期也算）；不存在、在别人会话里、非 UUID 一律 false', async () => {
  const clock = new TestClock();
  const s = store(clock);
  const owner = await deviceOwner();
  const sessionId = await seedSession(owner, START_MS - 1_000);
  const runId = await seedRun(sessionId, START_MS - 1_000);
  expect(await s.ownsRun(owner, runId)).toBe(true);
  clock.ms = START_MS + 2 * IDLE_MS;
  expect(await s.ownsRun(owner, runId)).toBe(true);

  const other = await deviceOwner();
  const otherRun = await seedRun(await seedSession(other, START_MS - 1_000), START_MS - 1_000);
  expect(await s.ownsRun(owner, otherRun)).toBe(false);
  expect(await s.ownsRun(owner, randomUUID())).toBe(false);
  expect(await s.ownsRun(owner, 'run-1')).toBe(false);
  // A user does not own the runs of its device's guest session.
  expect(await s.ownsRun(await userOwner(owner.deviceId), runId)).toBe(false);
});
