// B1-22u (编排裁定 D10-434 ②; BR-ID-24 ④, B1-22b): the Pinduoduo open judges the site authorization
// of the account in use against the injected Clock. The fixture's FixedClock (2026-10-08) is
// earlier than the wall clock, and the account's auth_expires_at lies between the two: by the
// injected clock it has not been reached, so the open goes on; by the wall clock it has, which
// would wrongly answer 50301 maintenance. The control half (reached by the injected clock) is
// still 50301 maintenance.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { SystemClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { success } from '../open-pdd-auth/assertions.ts';
import { service } from '../open-pdd-auth/kit.ts';
import {
  DAY_MS,
  TIMEOUT,
  databaseFixture,
  fixture,
  outcome,
  response,
  shifted,
  type Fixture,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

async function expiresAt(f: Fixture, at: Date): Promise<void> {
  await f.db
    .updateTable('union_accounts')
    .set({ auth_expires_at: at })
    .where('app_id', '=', f.appId)
    .where('id', '=', f.accountId)
    .execute();
}

const CASES = [
  { scene: 'detail', opener: 'a', noRebate: false },
  { scene: 'share', opener: 'b', noRebate: false },
  { scene: 'detail', opener: 'a', noRebate: true },
] as const;

for (const { scene, opener, noRebate } of CASES) {
  it(
    `[B1-22u] 拼多多 open ${scene}/${opener} no_rebate=${noRebate}：站长授权到期时刻晚于注入的 FixedClock、早于系统时间 → 按注入时钟未到期，照常转链；已过注入时钟时仍 50301 maintenance`,
    async () => {
      const db = database();
      const f = await fixture(db, { binding: 'active', query: false, scene });
      f.opener(opener);
      const expiry = shifted(f.clock, DAY_MS);
      // The window separates the two clocks: the wall clock is already past this instant.
      expect(new SystemClock().now().getTime()).toBeGreaterThan(expiry.getTime());
      await expiresAt(f, expiry);
      await success(await outcome(() => service(f).open(f.request({ noRebate }))));
      expect(f.convert).toHaveBeenCalledTimes(1);
      expect(await f.logs()).toEqual([
        expect.objectContaining({ link_id: f.row.link_id, result_code: 0 }),
      ]);

      const g = await fixture(db, { binding: 'active', query: false, scene });
      g.opener(opener);
      await expiresAt(g, shifted(g.clock, -1));
      const refused = await response(
        await outcome(() => service(g).open(g.request({ noRebate }))),
        50301,
        503,
      );
      expect(refused.envelope.data).toEqual({ reason: 'maintenance' });
      expect(g.convert).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );
}
