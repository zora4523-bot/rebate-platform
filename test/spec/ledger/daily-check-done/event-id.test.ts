// B2-02s: the event_id of the completion record of (app, D) (task brief §9.2: 由 app_id 与 D 确定性
// 推导的 uuid, as B2-02r's alert claim). It is the same for the same (app, D) in every call — so a
// restarted worker and the run store find the record the handler wrote — and differs for every
// other (app, D). Unit test: no database, no port. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { dailyCheckDoneEventId } from '../../../../apps/api/src/modules/ledger/index.ts';
import { APP, DAY, NEXT_DAY, OTHER, THIRD } from './kit.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

it('[AC-B2-02s#1] 完成记录的 event_id 由 (app_id, D) 确定：同一 (app, D) 每次相同且是 uuid；换 app 或换 D 各不相同', () => {
  const keys: [string, string][] = [
    [APP, DAY],
    [APP, NEXT_DAY],
    [OTHER, DAY],
    [OTHER, NEXT_DAY],
    [THIRD, DAY],
    [APP, '2032-12-31'],
    [APP, '2033-01-01'],
    // App ids that differ only around a separator or a prefix.
    [`${APP}:2032`, DAY],
    [`${APP}-`, DAY],
    ['dcs', DAY],
  ];
  const ids = keys.map(([appId, day]) => dailyCheckDoneEventId(appId, day));
  for (const [index, id] of ids.entries()) {
    const [appId, day] = keys[index]!;
    expect(id, JSON.stringify(keys[index])).toMatch(UUID);
    expect(dailyCheckDoneEventId(appId, day), JSON.stringify(keys[index])).toBe(id);
  }
  expect(new Set(ids).size).toBe(keys.length);
});
