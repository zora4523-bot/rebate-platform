import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  fixture,
  injectRecheck,
  openWith,
  outcome,
  pddSlots,
  response,
  slotSceneOf,
  type Fixture,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

/** ⑥ answered: 30111 with only auth_jump, a state bound to A's device and the opened link. */
async function expectFilingRefusal(f: Fixture, result: unknown, before: unknown) {
  const value = await response(result, 30111, 422);
  const data = value.envelope.data as { auth_jump: components['schemas']['AuthJumpPlan'] };
  expect(Object.keys(data)).toEqual(['auth_jump']);
  const sessions = await f.sessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    app_id: f.appId,
    user_id: f.a.userId,
    device_id: f.a.deviceId,
    platform: 'pdd',
    link_id: f.row.link_id,
    used_at: null,
  });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
  expect(await f.attempts()).toEqual([]);
  expect(await f.bindings()).toEqual(before);
  expect(await f.logs()).toEqual([
    expect.objectContaining({ link_id: f.row.link_id, result_code: 30111 }),
  ]);
}

// Not filed: no unreleased binding, or one that is pending_auth / invalid; the filing double
// answers "not authorized" whenever it is asked. Both accounts lose the scene's slot, so the
// answer does not depend on which account the authorization uses.
for (const binding of ['absent', 'pending_auth', 'invalid'] as const) {
  for (const scene of ['detail', 'agent'] as const) {
    it(`[AC-B1-22n#5] 拼多多 ${binding}/${scene} 未备案且无该场景 active 推广位：回 30111（授权门 ⑥ 先于推广位 ⑦），不复核、不调用备案查询以外的联盟接口；有推广位时同样 30111`, async () => {
      const db = database();
      const f = await fixture(db, { binding, query: false, scene });
      await injectRecheck(f, 'off_shelf');
      const missing = slotSceneOf(scene);
      const slots = await pddSlots(db, f, [
        { account: 'a', scene: missing },
        { account: 'b', scene: missing },
      ]);
      const before = await f.bindings();
      const stopped = openWith(f, slots.pids);
      await expectFilingRefusal(f, await outcome(() => stopped.service.open(f.request())), before);
      expect(stopped.external.filter((name) => name !== 'queryPddAuthority')).toEqual([]);

      const g = await fixture(db, { binding, query: false, scene });
      await injectRecheck(g, 'off_shelf');
      const kept = openWith(g, (await pddSlots(db, g)).pids);
      const unchanged = await g.bindings();
      await expectFilingRefusal(g, await outcome(() => kept.service.open(g.request())), unchanged);
      expect(g.query).toHaveBeenCalledTimes(1);
      expect(kept.external.filter((name) => name !== 'queryPddAuthority')).toEqual([]);
    }, TIMEOUT);
  }
}
