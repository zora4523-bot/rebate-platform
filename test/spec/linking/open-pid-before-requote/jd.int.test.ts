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
