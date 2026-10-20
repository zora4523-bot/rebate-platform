import { expect, it } from 'vitest';
import { fixture as adminFixture, signedIn, useHarness } from '../../admin/auth/kit.ts';
import { seed } from '../../admin/accounts/kit.ts';
import {
  conflict,
  listAll,
  member,
  owner,
  put,
  rejected,
  stepUp,
  updated,
} from '../kill-switches/kit.ts';
import { KEY, alerts, fixture, seedRow, snapshot } from './kit.ts';
import { orderedRace } from './ordered-race.ts';

const h = useHarness();

async function adminSetup(id: string) {
  const f = await adminFixture(h);
  const actor = await seed(h, id, { isSuper: true });
  const session = await signedIn(f, actor);
  return { ...f, appId: id, actor, token: session.admin_token };
}

it('[AC-F1-02zk#11] 系统关闭后后台列表显示 system，新旧写者共用版本：旧版本 PUT 返回 20902 kill_switch', async () => {
  const s = fixture();
  const f = await adminSetup(s.input.appId);
  await seedRow(h.db, f.appId, true);
  expect((await listAll(f, f.token)).find((row) => row.key === KEY)?.version).toBe(3);
  const result = await h.db.transaction().execute((trx) => s.writer.turnOff(trx, s.input));
  expect(result).toMatchObject({ changed: true, version: 4 });
  expect((await listAll(f, f.token)).find((row) => row.key === KEY)).toMatchObject({
    value: false,
    version: 4,
    updated_by: 'system',
  });
  const token = await stepUp(f, owner(f));
  const before = await snapshot(h.db, f.appId);
  await conflict(await put(f.app, owner(f), KEY, { value: true, expected_version: 3 }, token));
  expect(await snapshot(h.db, f.appId)).toEqual(before);
});

it('[AC-F1-02zk#12] 系统不需 step-up；重新打开仍需 switch.all 与 totp，无令牌 10003，有令牌 200', async () => {
  const s = fixture();
  const f = await adminSetup(s.input.appId);
  const allowed = await member(h, f, ['switch.all']);
  const denied = await member(h, f, ['switch.payout']);
  const result = await h.db.transaction().execute((trx) => s.writer.turnOff(trx, s.input));
  expect(result).toMatchObject({ changed: true, version: 1 });
  const deniedToken = await stepUp(f, denied);
  await rejected(
    await put(f.app, denied, KEY, { value: true, expected_version: 1 }, deniedToken),
    'update',
    10403,
    { reason: 'admin_permission_denied' },
  );
  const before = await snapshot(h.db, f.appId);
  await rejected(
    await put(f.app, allowed, KEY, { value: true, expected_version: 1 }, null),
    'update',
    10003,
    { tier: 'totp' },
  );
  expect(await snapshot(h.db, f.appId)).toEqual(before);
  const token = await stepUp(f, allowed);
  expect(
    await updated(await put(f.app, allowed, KEY, { value: true, expected_version: 1 }, token)),
  ).toMatchObject({ value: true, version: 2, updated_by: allowed.account.username });
  const after = await snapshot(h.db, f.appId);
  expect(after.versions.map((row) => [row.version, row.value, row.updated_by_admin_id])).toEqual([
    [1, false, null],
    [2, true, allowed.account.id],
  ]);
});

it.each([false, true])(
  '[AC-F1-02zk#13] 已有行初值=%s：系统与后台写交错，锁后重读，版本和历史一一对应',
  async (initial) => {
    const s = fixture();
    const f = await adminSetup(s.input.appId);
    await seedRow(h.db, f.appId, initial);
    const token = await stepUp(f, owner(f));
    const result = await orderedRace(
      h.db,
      true,
      (trx) => s.writer.turnOff(trx, s.input),
      async () => {
        expect(
          await updated(
            await put(f.app, owner(f), KEY, { value: !initial, expected_version: 3 }, token),
          ),
        ).toMatchObject({ value: !initial, version: 4 });
      },
    );
    expect(result).toEqual({
      key: KEY,
      changed: !initial,
      version: initial ? 4 : 5,
      fromValue: !initial,
    });
    const after = await snapshot(h.db, f.appId);
    expect(after.items).toEqual([
      expect.objectContaining({
        value: false,
        version: initial ? 4 : 5,
        row_version: initial ? 8 : 9,
      }),
    ]);
    expect(after.versions.map((row) => [row.version, row.value, row.updated_by_admin_id])).toEqual(
      initial
        ? [[4, false, f.actor.id]]
        : [
            [4, true, f.actor.id],
            [5, false, null],
          ],
    );
    expect(after.audits.filter((row) => row.action === 'kill_switch_change')).toHaveLength(1);
    expect(alerts(s.lines)).toEqual([]);
  },
);

it.each([false, true])(
  '[AC-F1-02zk#14] 并发首写后台先落值=%s：系统 INSERT 冲突后重锁，不丢版本也不多写历史',
  async (adminValue) => {
    const s = fixture();
    const f = await adminSetup(s.input.appId);
    const token = await stepUp(f, owner(f));
    const result = await orderedRace(
      h.db,
      false,
      (trx) => s.writer.turnOff(trx, s.input),
      async () => {
        expect(
          await updated(
            await put(f.app, owner(f), KEY, { value: adminValue, expected_version: 0 }, token),
          ),
        ).toMatchObject({ value: adminValue, version: 1 });
      },
    );
    expect(result).toEqual({
      key: KEY,
      changed: adminValue,
      version: adminValue ? 2 : 1,
      fromValue: adminValue,
    });
    const after = await snapshot(h.db, f.appId);
    expect(after.items).toEqual([
      expect.objectContaining({
        value: false,
        version: adminValue ? 2 : 1,
        row_version: adminValue ? 1 : 0,
      }),
    ]);
    expect(after.versions.map((row) => [row.version, row.value, row.updated_by_admin_id])).toEqual(
      adminValue
        ? [
            [1, true, f.actor.id],
            [2, false, null],
          ]
        : [[1, false, f.actor.id]],
    );
    expect(after.audits.filter((row) => row.action === 'kill_switch_change')).toHaveLength(1);
    expect(alerts(s.lines)).toEqual([]);
  },
);

it('[AC-F1-02zk#15] 两个系统同时首次关闭：只有一条版本 1 历史和一次提交后告警', async () => {
  const s = fixture();
  let rivalChanged: boolean | undefined;
  const result = await orderedRace(
    h.db,
    false,
    (trx) => s.writer.turnOff(trx, s.input),
    async () => {
      const rival = await h.db.transaction().execute((trx) => s.writer.turnOff(trx, s.input));
      rivalChanged = rival.changed;
      s.writer.alertCommitted(s.input, rival);
    },
  );
  expect(rivalChanged).toBe(true);
  expect(result).toEqual({ key: KEY, changed: false, version: 1, fromValue: false });
  s.writer.alertCommitted(s.input, result);
  const after = await snapshot(h.db, s.input.appId);
  expect(after.items).toEqual([
    expect.objectContaining({ value: false, version: 1, row_version: 0 }),
  ]);
  expect(after.versions.map((row) => [row.version, row.updated_by_admin_id])).toEqual([[1, null]]);
  expect(after.audits).toEqual([]);
  expect(alerts(s.lines)).toHaveLength(1);
});
