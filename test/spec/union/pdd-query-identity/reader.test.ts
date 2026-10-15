import { expect, it } from 'vitest';
import { readActivePddQueryPid } from '../../../../apps/api/src/modules/union/pids/query-reader.ts';
import { APP, OTHER_APP, candidate, pidDatabase } from './kit.ts';

it('[AC-B1-04x-READ#1] 只读入口按 app/pdd/query/active 查推广位，无超级账号或审计依赖', async () => {
  const database = pidDatabase([
    candidate({ app_id: OTHER_APP, pid: 'other-app-pid' }),
    candidate({ platform: 'jd', pid: 'jd-pid' }),
    candidate({ pid_scene: 'self_buy', pid: 'self-buy-pid' }),
    candidate({ status: 'pending', pid: 'pending-pid' }),
    candidate({ status: 'retired', pid: 'retired-pid' }),
    candidate(),
  ]);
  try {
    expect(await readActivePddQueryPid(database.db, APP)).toBe('synthetic-query-pid');
    expect(await readActivePddQueryPid(database.db, OTHER_APP)).toBe('other-app-pid');
    expect(database.statements).toHaveLength(2);
  } finally {
    await database.db.destroy();
  }
});

it.each([
  { app_id: OTHER_APP },
  { platform: 'jd' },
  { platform: 'taobao' },
  { pid_scene: 'self_buy' },
  { pid_scene: 'share' },
  { pid_scene: 'agent' },
  { pid_scene: 'taolijin' },
  { pid_scene: 'fallback' },
  { status: 'pending' },
  { status: 'retired' },
])('[AC-B1-04x-READ#2] 没有查询位时返回 null，不能回退到 %j', async (decoy) => {
  const database = pidDatabase([candidate(decoy)]);
  try {
    expect(await readActivePddQueryPid(database.db, APP)).toBeNull();
    expect(database.statements).toHaveLength(1);
  } finally {
    await database.db.destroy();
  }
});

it('[AC-B1-04x-READ#3] 每次重查 active 查询位，不缓存退役或其他 app 的结果', async () => {
  const database = pidDatabase();
  try {
    expect(await readActivePddQueryPid(database.db, APP)).toBe('synthetic-query-pid');
    database.replace([candidate({ pid: 'replacement-query-pid' })]);
    expect(await readActivePddQueryPid(database.db, APP)).toBe('replacement-query-pid');
    database.replace([]);
    expect(await readActivePddQueryPid(database.db, APP)).toBeNull();
    expect(database.statements).toHaveLength(3);
  } finally {
    await database.db.destroy();
  }
});
