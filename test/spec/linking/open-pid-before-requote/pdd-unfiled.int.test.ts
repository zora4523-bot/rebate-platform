import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  expectFilingRefusal,
  fixture,
  injectRecheck,
  openWith,
  outcome,
  pddSlots,
  slotSceneOf,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

// Not filed: no unreleased binding, or one that is pending_auth / invalid; the filing double
// answers "not authorized" whenever it is asked. Both accounts lose the scene's slot, so the
// answer does not depend on which account the authorization uses. Without the slot the filing is
// not queried at all (D10-262 / D10-263: local configuration before external calls): the binding
// is not active, so ⑥ answers 30111 straight away; with the slot it is queried once as before.
for (const binding of ['absent', 'pending_auth', 'invalid'] as const) {
  for (const scene of ['detail', 'agent'] as const) {
    it(
      `[AC-B1-22n#5] 拼多多 ${binding}/${scene} 未备案且无该场景 active 推广位：不调用备案查询、直接回 30111（授权门 ⑥ 先于推广位 ⑦），不复核、不调用任何联盟接口；有推广位时查一次备案、同样 30111`,
      async () => {
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
        await expectFilingRefusal(
          f,
          await outcome(() => stopped.service.open(f.request())),
          before,
        );
        expect(f.query).not.toHaveBeenCalled();
        expect(stopped.external).toEqual([]);

        const g = await fixture(db, { binding, query: false, scene });
        await injectRecheck(g, 'off_shelf');
        const kept = openWith(g, (await pddSlots(db, g)).pids);
        const unchanged = await g.bindings();
        await expectFilingRefusal(
          g,
          await outcome(() => kept.service.open(g.request())),
          unchanged,
        );
        expect(g.query).toHaveBeenCalledTimes(1);
        expect(kept.external.filter((name) => name !== 'queryPddAuthority')).toEqual([]);
      },
      TIMEOUT,
    );
  }
}
