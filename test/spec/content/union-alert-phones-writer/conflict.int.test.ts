// F1-02zzj §9.2 ③ / §9.3 ②: expected_version CAS. A mismatch is the conflict error and writes
// nothing (checked inside the caller's transaction, so "write then throw" cannot hide behind a
// rollback); concurrent writers of the same version: the first to commit wins.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { UnionAlertPhonesConflictError } from '../../../../apps/api/src/modules/content/index.ts';
import {
  KEY,
  blockedOrSettled,
  cipherValue,
  databaseHarness,
  fixture,
  leaked,
  seedWritten,
  snapshot,
} from './kit.ts';

const h = databaseHarness(createTestDatabase);

it.each([
  ['无行给 1', 0, 1],
  ['无行给 5', 0, 5],
  ['有行 v3 给 0（当作首写）', 3, 0],
  ['有行 v3 给旧值 2', 3, 2],
  ['有行 v3 给 1', 3, 1],
  ['有行 v3 给 4（超前）', 3, 4],
] as const)(
  '[AC-F1-02zzj#7] 版本不符（%s）：冲突错误，事务内与提交后两表都不变，日志不带值',
  async (_label, current, expectedVersion) => {
    const f = fixture();
    const id = f.input.appId;
    if (current > 0) await seedWritten(h.db, id, current);
    const before = await snapshot(h.db, id);
    await h.db.transaction().execute(async (trx) => {
      await expect(async () =>
        f.writer.write(trx, { ...f.input, value: cipherValue('lost'), expectedVersion }),
      ).rejects.toBeInstanceOf(UnionAlertPhonesConflictError);
      expect(await snapshot(trx, id)).toEqual(before);
    });
    expect(await snapshot(h.db, id)).toEqual(before);
    expect(leaked(f.lines)).toEqual([]);
  },
);

it.each([false, true])(
  '[AC-F1-02zzj#8] 两个调用方并发用同一版本写（已有行=%s）：先提交者成功，另一方冲突，只留先者的一行历史',
  async (existing) => {
    const f = fixture();
    const id = f.input.appId;
    if (existing) await seedWritten(h.db, id, 1);
    const before = await snapshot(h.db, id);
    const expectedVersion = existing ? 1 : 0;
    const winner = cipherValue('winner');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const written = new Promise<void>((resolve) => (reached = resolve));
    const first = h.db.transaction().execute(async (trx) => {
      const result = await f.writer.write(trx, { ...f.input, value: winner, expectedVersion });
      reached();
      await hold;
      return result;
    });
    await Promise.race([written, first]);
    const second = h.db
      .transaction()
      .execute((trx) =>
        f.writer.write(trx, {
          ...f.input,
          value: cipherValue('loser'),
          expectedVersion,
          adminId: randomUUID(),
        }),
      )
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    await blockedOrSettled(h.db, second);
    release();
    expect(await first).toEqual({ version: expectedVersion + 1 });
    expect(await second).toEqual({ error: expect.any(UnionAlertPhonesConflictError) });
    const after = await snapshot(h.db, id);
    expect(after.items).toEqual([
      expect.objectContaining({ key: KEY, value: winner, version: expectedVersion + 1 }),
    ]);
    expect(after.versions).toEqual([
      ...before.versions,
      expect.objectContaining({
        key: KEY,
        version: expectedVersion + 1,
        value: winner,
        updated_by_admin_id: f.adminId,
      }),
    ]);
    expect(after.audits).toEqual(before.audits);
  },
);
