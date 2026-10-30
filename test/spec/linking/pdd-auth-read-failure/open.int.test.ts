import { createTestDatabase } from '@couli/db/testing';
import { it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  databaseTimeout,
  expectReadFailure,
  expectStoppedBeforeRecheck,
  fixture,
  openWatched,
  outcome,
  pidsWith,
  precheckRead,
  readFailure,
  slotSceneOf,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

// Own detail (self_buy) and agent links, and A's share link opened by B (the sharer's share slot).
// Pinduoduo: A's binding is active, so the open goes straight to ⑦ (no filing query); jd has no ⑥.
const CASES = [
  { scene: 'detail', opener: 'a' },
  { scene: 'agent', opener: 'a' },
  { scene: 'share', opener: 'b' },
] as const;

const BINDING = { pdd: 'active', jd: 'absent' } as const;

for (const platform of ['pdd', 'jd'] as const) {
  for (const { scene, opener } of CASES) {
    it(
      `[B1-22u] ${platform} ${scene}/${opener} 价格复核前预检读推广位遇数据库超时（非 50301）：答 50303、写一条 link_log、不 500、无其他写入；推广位缺失时仍答 50301`,
      async () => {
        const db = database();
        const binding = BINDING[platform];
        const f = await fixture(db, { binding, query: false, platform, scene });
        f.opener(opener);
        const before = await f.bindings();
        const failing = openWatched(
          f,
          pidsWith(f, precheckRead(f, slotSceneOf(scene)), databaseTimeout()),
        );
        await expectReadFailure(
          f,
          await outcome(() => failing.service.open(f.request())),
          failing,
          before,
        );

        // Unchanged: no active slot (a read that succeeds with none) is still ⑦'s 50301.
        const g = await fixture(db, { binding, query: false, platform, scene });
        g.opener(opener);
        const none = openWatched(g, pidsWith(g, precheckRead(g, slotSceneOf(scene)), null));
        await expectStoppedBeforeRecheck(g, await outcome(() => none.service.open(g.request())));
      },
      TIMEOUT,
    );

    it(
      `[B1-22u] ${platform} ${scene}/${opener} 价格复核前预检读 attr_code 失败（无错误码）：答 50303、写一条 link_log、不 500、无其他写入；attr_code 缺失时仍答 50301`,
      async () => {
        const db = database();
        const binding = BINDING[platform];
        const f = await fixture(db, { binding, query: false, platform, scene });
        f.opener(opener);
        f.attrCode.mockRejectedValue(readFailure());
        const before = await f.bindings();
        const failing = openWatched(f);
        await expectReadFailure(
          f,
          await outcome(() => failing.service.open(f.request())),
          failing,
          before,
        );

        const g = await fixture(db, { binding, query: false, platform, scene });
        g.opener(opener);
        g.attrCode.mockResolvedValue(null);
        const none = openWatched(g);
        await expectStoppedBeforeRecheck(g, await outcome(() => none.service.open(g.request())));
      },
      TIMEOUT,
    );
  }

  it(
    `[B1-22u] ${platform} no_rebate 预检读 self_buy 推广位遇数据库超时：答 50303、写一条 no_rebate link_log、不 500、无其他写入；self_buy 位缺失时仍答 50301`,
    async () => {
      const db = database();
      const binding = BINDING[platform];
      const f = await fixture(db, { binding, query: false, platform, scene: 'agent' });
      const before = await f.bindings();
      const failing = openWatched(
        f,
        pidsWith(f, precheckRead(f, slotSceneOf('agent', true)), databaseTimeout()),
      );
      await expectReadFailure(
        f,
        await outcome(() => failing.service.open(f.request({ noRebate: true }))),
        failing,
        before,
        true,
      );

      const g = await fixture(db, { binding, query: false, platform, scene: 'agent' });
      const none = openWatched(g, pidsWith(g, precheckRead(g, slotSceneOf('agent', true)), null));
      await expectStoppedBeforeRecheck(
        g,
        await outcome(() => none.service.open(g.request({ noRebate: true }))),
      );
    },
    TIMEOUT,
  );
}
