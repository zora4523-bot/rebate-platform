// F1-02zzl · ruling D10-318 (brief §9.2 ②③, §9.3 ②③): the report reads the subject's users row
// (app_id, command.user_id) under its lock. status ∈ {deleting, deleted}, or no users row of that
// app, → the whole report is ignored the way a non-current session is (push-token-report.ts header
// rule 1): no push_tokens row is inserted, updated, revoked or frozen, report() resolves, no new
// error code, no log line carries the token value. A normal account's report is unchanged
// (insert; same value → binding only, token_set_at kept).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DB_TIMEOUT,
  RESOLVED,
  closeSuite,
  command,
  expectNoTokenText,
  fixture,
  mark,
  openSuite,
  ownRow,
  setStatus,
  settle,
  type GoneStatus,
  type Suite,
} from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

for (const [status, reason] of [
  ['deleting', null],
  ['deleted', 'account_deleted'],
  ['deleted', 'merged'],
] as const satisfies readonly (readonly [GoneStatus, string | null])[]) {
  it(
    `[D10-318][BR-ID-28][BR-ID-30] 用户 status=${status}（deleted_reason=${String(reason)}）时上报：改报新值、重报同值、在无行的设备上首次上报、报另一设备上的有效值，都整次忽略——不新建、不改、不作废、不冻结任何行，每次上报照常 resolve，无冲突日志、日志不含令牌值`,
    async () => {
      const f = await fixture(suite);
      const d1 = await f.device('2026-09-01T00:00:00.000Z');
      const d2 = await f.device('2026-09-10T00:00:00.000Z');
      const a1 = await f.login(d1);
      const a2 = await f.login(d2, a1.user_id);
      f.at('2026-10-05T05:00:00.000Z');
      await f.report(a1, 'pd-status-a-001');
      expect(await ownRow(f, d1)).toMatchObject({
        token: 'pd-status-a-001',
        user_id: a1.user_id,
        bound_sid: a1.sid,
      });
      await setStatus(f, a1.user_id, status, reason);
      const before = await f.all();
      f.at('2026-10-06T05:00:00.000Z');
      const since = mark(f);

      const settled = [
        await settle(f.report(a1, 'pd-status-a-002')),
        await settle(f.report(a1, 'pd-status-a-001')),
        await settle(f.report(a2, 'pd-status-a-003')),
        await settle(f.report(a2, 'pd-status-a-001')),
      ];

      expect(settled).toEqual([RESOLVED, RESOLVED, RESOLVED, RESOLVED]);
      expect(await f.all()).toEqual(before);
      expect(await f.rowsOf(d2)).toEqual([]);
      const conflicts = f
        .logged()
        .slice(since)
        .filter((line) => line['code'] === 'PUSH_TOKEN_CONFLICT');
      expect(conflicts).toEqual([]);
      for (const token of ['pd-status-a-001', 'pd-status-a-002', 'pd-status-a-003']) {
        expectNoTokenText(f, token);
      }
    },
    DB_TIMEOUT,
  );
}

it(
  '[D10-318] 上报主体在该 app 没有 users 行（同 id 只在别的 app 有、或根本不存在），会话却是设备当前会话：与非当前会话同口径整次忽略，不写任何行，上报照常 resolve（不因外键报错）',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const actor = await f.login(d1);
    const elsewhere = await f.user(`${f.appId}_other`);
    f.at('2026-10-05T05:00:00.000Z');

    const settled = [
      await settle(
        f.reporter().report(command(f, { ...actor, user_id: elsewhere }, 'pd-ghost-a-001')),
      ),
      await settle(
        f.reporter().report(command(f, { ...actor, user_id: randomUUID() }, 'pd-ghost-a-002')),
      ),
    ];

    expect(settled).toEqual([RESOLVED, RESOLVED]);
    expect(await f.all()).toEqual([]);
    expectNoTokenText(f, 'pd-ghost-a-001');
    expectNoTokenText(f, 'pd-ghost-a-002');
  },
  DB_TIMEOUT,
);

it(
  '[D10-318][BR-ID-07] 正常用户行为不变：同 app 另一用户注销中、其上报被整次忽略的同时，正常用户首次上报新建一行（token_set_at 取 Clock），换新会话重报同值只换绑定、token_set_at 不推进',
  async () => {
    const f = await fixture(suite);
    const d1 = await f.device('2026-09-01T00:00:00.000Z');
    const d2 = await f.device('2026-09-02T00:00:00.000Z');
    const normal = await f.login(d1);
    const leaving = await f.login(d2);
    await setStatus(f, leaving.user_id, 'deleting');

    f.at('2026-10-05T05:00:00.000Z');
    expect(await settle(f.report(normal, 'pd-normal-a-001'))).toEqual(RESOLVED);
    expect(await settle(f.report(leaving, 'pd-normal-b-001'))).toEqual(RESOLVED);
    expect(await f.rowsOf(d1)).toEqual([
      expect.objectContaining({
        token: 'pd-normal-a-001',
        user_id: normal.user_id,
        bound_sid: normal.sid,
        token_set_at: new Date('2026-10-05T05:00:00.000Z'),
        acquired_by_move_at: null,
        frozen_until: null,
        revoked_at: null,
      }),
    ]);
    expect(await f.rowsOf(d2)).toEqual([]);

    f.at('2026-10-05T06:00:00.000Z');
    const again = await f.login(d1, normal.user_id);
    expect(await settle(f.report(again, 'pd-normal-a-001'))).toEqual(RESOLVED);
    expect(await ownRow(f, d1)).toMatchObject({
      token: 'pd-normal-a-001',
      user_id: normal.user_id,
      bound_sid: again.sid,
      token_set_at: new Date('2026-10-05T05:00:00.000Z'),
      revoked_at: null,
    });
    expect(await f.all()).toHaveLength(1);
  },
  DB_TIMEOUT,
);
