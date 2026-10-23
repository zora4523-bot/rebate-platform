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
  jdPids,
  openWith,
  outcome,
  slotSceneOf,
  withSetting,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

// Own detail (self_buy) and agent links, and A's share link opened by B (the sharer's share slot).
const CASES = [
  { scene: 'detail', opener: 'a' },
  { scene: 'agent', opener: 'a' },
  { scene: 'share', opener: 'b' },
] as const;

for (const { scene, opener } of CASES) {
  for (const { recheck, withSlot } of RECHECKS) {
    it(`[AC-B1-22n#1] 京东 ${scene}/${opener} 该场景无 active 推广位：先回 50301、不做价格复核（复核注入 ${recheck}）；有推广位时照旧复核得 ${withSlot}`, async () => {
      const db = database();
      const f = await fixture(db, { binding: 'absent', query: false, platform: 'jd', scene });
      f.opener(opener);
      await injectRecheck(f, recheck);
      const stopped = openWith(f, jdPids(f, slotSceneOf(scene)));
      await expectStoppedBeforeRecheck(f, await outcome(() => stopped.service.open(f.request())));
      expect(stopped.external).toEqual([]);

      const g = await fixture(db, { binding: 'absent', query: false, platform: 'jd', scene });
      g.opener(opener);
      await injectRecheck(g, recheck);
      const kept = openWith(g, g.options.pids);
      expectRecheckDecided(g, await outcome(() => kept.service.open(g.request())), withSlot);
    }, TIMEOUT);
  }
}

it('[AC-B1-22n#2] 京东 no_rebate 改用 self_buy 位：self_buy 无 active 推广位时先回 50301、不复核，不沿用 agent 位；有 self_buy 位时照旧复核', async () => {
  const db = database();
  const f = await fixture(db, { binding: 'absent', query: false, platform: 'jd', scene: 'agent' });
  await injectRecheck(f, 'off_shelf');
  const stopped = openWith(f, jdPids(f, slotSceneOf('agent', true)));
  await expectStoppedBeforeRecheck(
    f,
    await outcome(() => stopped.service.open(f.request({ noRebate: true }))),
  );
  expect(stopped.external).toEqual([]);

  const g = await fixture(db, { binding: 'absent', query: false, platform: 'jd', scene: 'agent' });
  await injectRecheck(g, 'off_shelf');
  const kept = openWith(g, g.options.pids);
  expectRecheckDecided(
    g,
    await outcome(() => kept.service.open(g.request({ noRebate: true }))),
    30141,
  );
}, TIMEOUT);

// BR-ATTR-05 ⑦ / BR-ATTR-06: in the private-position downgrade the slot is the identity owner's
// active private position (user_union_positions, taken as self_buy); this fixture seeds none, while
// every union_pids slot stays active. Serving the mode is CAP-JD-05's (TODO), so there is no
// "with the slot" half here: only the stop before the re-check.
for (const { scene, opener } of CASES) {
  for (const { recheck } of RECHECKS) {
    it(`[AC-B1-22n#7] 京东 ${scene}/${opener} attr.jd.user_key_mode=private_position 且身份主人无 active 私域推广位：先回 50301、不做价格复核（复核注入 ${recheck}）`, async () => {
      const db = database();
      const f = await fixture(db, { binding: 'absent', query: false, platform: 'jd', scene });
      f.opener(opener);
      await injectRecheck(f, recheck);
      const stopped = openWith(
        f,
        f.options.pids,
        withSetting(f, 'attr.jd.user_key_mode', 'private_position'),
      );
      await expectStoppedBeforeRecheck(f, await outcome(() => stopped.service.open(f.request())));
      expect(stopped.external).toEqual([]);
    }, TIMEOUT);
  }
}
