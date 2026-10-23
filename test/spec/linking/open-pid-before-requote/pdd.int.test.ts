import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  RECHECKS,
  TIMEOUT,
  databaseFixture,
  expectRecheckDecided,
  expectStoppedBeforeRecheck,
  fixture,
  injectRecheck,
  openWith,
  outcome,
  pddSlots,
  slotSceneOf,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

// A's active binding is on account A; account B keeps every slot (never borrowed, BR-ATTR-05 ⑦).
const CASES = [
  { scene: 'detail', opener: 'a' },
  { scene: 'agent', opener: 'a' },
  { scene: 'share', opener: 'b' },
] as const;

for (const { scene, opener } of CASES) {
  for (const { recheck, withSlot } of RECHECKS) {
    it(`[AC-B1-22n#3] 拼多多 active ${scene}/${opener} 所用账号无该场景 active 推广位：先回 50301、不做价格复核（复核注入 ${recheck}）；有推广位时照旧复核得 ${withSlot}`, async () => {
      const db = database();
      const f = await fixture(db, { binding: 'active', query: true, scene });
      f.opener(opener);
      await injectRecheck(f, recheck);
      const slots = await pddSlots(db, f, [{ account: 'a', scene: slotSceneOf(scene) }]);
      const stopped = openWith(f, slots.pids);
      await expectStoppedBeforeRecheck(f, await outcome(() => stopped.service.open(f.request())));
      expect(f.query).not.toHaveBeenCalled();
      expect(stopped.external).toEqual([]);

      const g = await fixture(db, { binding: 'active', query: true, scene });
      g.opener(opener);
      await injectRecheck(g, recheck);
      const kept = openWith(g, (await pddSlots(db, g)).pids);
      expectRecheckDecided(g, await outcome(() => kept.service.open(g.request())), withSlot);
    }, TIMEOUT);
  }
}

for (const binding of ['active', 'pending_auth'] as const) {
  it(`[AC-B1-22n#4] 拼多多 no_rebate/${binding} 改用所用账号的 self_buy 位：无 active 时先回 50301、不复核、不查备案，不沿用 agent 位；有 self_buy 位时照旧复核`, async () => {
    const db = database();
    const f = await fixture(db, { binding, query: true, scene: 'agent' });
    await injectRecheck(f, 'off_shelf');
    const slots = await pddSlots(db, f, [{ account: 'a', scene: slotSceneOf('agent', true) }]);
    const stopped = openWith(f, slots.pids);
    await expectStoppedBeforeRecheck(
      f,
      await outcome(() => stopped.service.open(f.request({ noRebate: true }))),
    );
    expect(f.query).not.toHaveBeenCalled();
    expect(stopped.external).toEqual([]);
    expect(await f.sessions()).toEqual([]);

    const g = await fixture(db, { binding, query: true, scene: 'agent' });
    await injectRecheck(g, 'off_shelf');
    const kept = openWith(g, (await pddSlots(db, g)).pids);
    expectRecheckDecided(
      g,
      await outcome(() => kept.service.open(g.request({ noRebate: true }))),
      30141,
    );
    expect(g.query).not.toHaveBeenCalled();
  }, TIMEOUT);
}
