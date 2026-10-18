import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EMPTY_SOURCE, runUpdate, scenario, sourcesFor } from './db-kit.ts';
import { NONE } from './kit.ts';

// Global setup supplies the migrated template; queries use couli_app.
let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it.each(['product', 'none'] as const)(
  '[AC-B1-08j#37] source_match=%s 写过之后再同步不重跑且四列不变',
  async (kind) => {
    const f = await scenario(db, {}, { unattributed: true });
    const s = await sourcesFor(f);
    f.findUser.mockResolvedValue(f.userId);
    if (kind === 'none') s.linkLogs.mockResolvedValue([]);
    expect(await runUpdate(f, s.ports)).toMatchObject({ ok: true });
    const expected = kind === 'none' ? NONE : s.expected;
    expect((await f.read()).orders[0]).toMatchObject(expected);
    s.linkLogs.mockClear();
    s.productKey.mockClear();
    s.linkByCode.mockClear();
    f.findPid.mockClear();
    f.clock.advanceMs(60_000);
    expect(await runUpdate(f, s.ports)).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect((await f.read()).orders[0]).toMatchObject({ ...expected, user_id: f.userId });
    expect(s.linkLogs).not.toHaveBeenCalled();
    expect(s.productKey).not.toHaveBeenCalled();
    expect(s.linkByCode).not.toHaveBeenCalled();
    expect(f.findPid).not.toHaveBeenCalled();
  },
);

it.each(['locked', 'failed', 'already-attributed', 'no-sources'] as const)(
  '[AC-B1-08j#38] %s 不回填；同入口空身份成功对照必须回填',
  async (condition) => {
    // A positive control prevents legacy behavior from making this guard test green.
    const control = await scenario(db, {}, { unattributed: true });
    const c = await sourcesFor(control);
    control.findUser.mockResolvedValue(control.userId);
    expect(await runUpdate(control, c.ports)).toMatchObject({ ok: true });
    expect((await control.read()).orders[0]).toMatchObject(c.expected);
    const f = await scenario(db, {}, { unattributed: condition !== 'already-attributed' });
    const s = await sourcesFor(f);
    if (condition !== 'failed') f.findUser.mockResolvedValue(f.userId);
    if (condition === 'locked') {
      await db
        .updateTable('orders')
        .set({ locked: true })
        .where('app_id', '=', f.ctx.app_id)
        .execute();
    }
    expect(await runUpdate(f, condition === 'no-sources' ? undefined : s.ports)).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });
    expect((await f.read()).orders[0]).toMatchObject({
      ...EMPTY_SOURCE,
      user_id: condition === 'locked' || condition === 'failed' ? null : f.userId,
    });
    expect(s.linkLogs).not.toHaveBeenCalled();
    expect(s.productKey).not.toHaveBeenCalled();
    expect(s.linkByCode).not.toHaveBeenCalled();
  },
);

it.each(['none', 'product'] as const)(
  '[AC-B1-08j#39] 即使 user_id 为空，已有 source_match=%s 也不得改写来源',
  async (kind) => {
    const control = await scenario(db, {}, { unattributed: true });
    const c = await sourcesFor(control);
    control.findUser.mockResolvedValue(control.userId);
    expect(await runUpdate(control, c.ports)).toMatchObject({ ok: true });
    expect((await control.read()).orders[0]).toMatchObject(c.expected);
    const f = await scenario(db, {}, { unattributed: true });
    const s = await sourcesFor(f);
    const stored = kind === 'none' ? { ...NONE, source_match: 'none' } : s.expected;
    await db.updateTable('orders').set(stored).where('app_id', '=', f.ctx.app_id).execute();
    f.findUser.mockResolvedValue(f.userId);
    expect(await runUpdate(f, s.ports)).toMatchObject({ ok: true });
    expect((await f.read()).orders[0]).toMatchObject(stored);
    expect(s.linkLogs).not.toHaveBeenCalled();
    expect(s.productKey).not.toHaveBeenCalled();
  },
);
