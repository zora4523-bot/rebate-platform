import { expect, it } from 'vitest';
import { readTaobaoOrderSlots } from '../../../../apps/api/src/modules/union/pids/taobao-order-slots.ts';
import { APP, OTHER_APP, isHarnessError, pidDatabase, pidRow } from './kit.ts';

// The order slot reader (D10-488 ③; BR-ATTR-02: pending / active / retired all stay on the
// whitelist): every Taobao PID of the app in union_pids, whatever its status or scene, as PID
// text. One SELECT per call, no cache, no write; a failed read is not turned into an empty list.

const sorted = (values: readonly string[]): string[] => [...values].sort();

it('[AC-B1-04zn#11] 读当前 app 的全部淘宝推广位（含 retired、pending，各场景），不含其他 app 或其他平台', async () => {
  const active = pidRow({ pid: 'mm_1000000001_3000000001_111111111101' });
  const retired = pidRow({
    pid: 'mm_1000000001_3000000001_111111111102',
    status: 'retired',
    pid_scene: 'share',
  });
  const pending = pidRow({
    pid: 'mm_1000000001_3000000001_111111111103',
    status: 'pending',
    pid_scene: 'agent',
  });
  const fallback = pidRow({ pid: 'mm_1000000001_3000000001_111111111104', pid_scene: 'fallback' });
  const query = pidRow({ pid: 'mm_1000000001_3000000001_111111111105', pid_scene: 'query' });
  const otherApp = pidRow({ app_id: OTHER_APP, pid: 'mm_1000000001_3000000001_222222222201' });
  const pdd = pidRow({ platform: 'pdd', pid: 'synthetic-pdd-pid', pid_scene: 'query' });
  const jd = pidRow({ platform: 'jd', pid: 'synthetic-jd-position' });
  const database = pidDatabase([active, retired, pending, fallback, query, otherApp, pdd, jd]);
  try {
    const slots = await readTaobaoOrderSlots(database.db, APP);
    expect(Array.isArray(slots)).toBe(true);
    expect(sorted(slots)).toEqual(
      sorted([active.pid, retired.pid, pending.pid, fallback.pid, query.pid]),
    );
    expect(await readTaobaoOrderSlots(database.db, OTHER_APP)).toEqual([otherApp.pid]);
    expect(database.statements).toHaveLength(2);
    expect(database.statements.map((statement) => statement.parameters)).toEqual([
      expect.arrayContaining([APP, 'taobao']),
      expect.arrayContaining([OTHER_APP, 'taobao']),
    ]);
  } finally {
    await database.db.destroy();
  }
});

it('[AC-B1-04zn#12] 每次调用重查一次（不缓存）；没有淘宝推广位时返回空列表', async () => {
  const first = pidRow({ pid: 'mm_1000000001_3000000001_333333333301' });
  const database = pidDatabase([first]);
  try {
    expect(await readTaobaoOrderSlots(database.db, APP)).toEqual([first.pid]);
    const retiredNow = { ...first, status: 'retired' };
    const added = pidRow({ pid: 'mm_1000000001_3000000001_333333333302' });
    database.replace([retiredNow, added]);
    expect(sorted(await readTaobaoOrderSlots(database.db, APP))).toEqual(
      sorted([first.pid, added.pid]),
    );
    database.replace([pidRow({ platform: 'pdd', pid: 'synthetic-pdd-only', pid_scene: 'query' })]);
    expect(await readTaobaoOrderSlots(database.db, APP)).toEqual([]);
    expect(database.statements).toHaveLength(3);
    expect(database.archived).toHaveLength(0);
  } finally {
    await database.db.destroy();
  }
});

it('[AC-B1-04zn#13] 读库失败原样抛出，不当成空清单', async () => {
  const database = pidDatabase([pidRow()]);
  database.fail(new Error('FAKE_UNION_PIDS_READ_FAILURE'));
  try {
    let caught: unknown;
    let answer: unknown;
    try {
      answer = await readTaobaoOrderSlots(database.db, APP);
    } catch (error) {
      if (isHarnessError(error)) throw error;
      caught = error;
    }
    expect(answer).toBeUndefined();
    expect(caught).toBeInstanceOf(Error);
    expect(database.statements).toHaveLength(1);
  } finally {
    await database.db.destroy();
  }
});
