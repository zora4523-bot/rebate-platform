import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createUnionAuthReads } from '../../../../apps/api/src/modules/linking/application/union-auth-reads.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import { createUnionSyncAccess } from '../../../../apps/api/src/modules/union/index.ts';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { memoryLogger } from '../../platform/queue/kit.ts';
import { account, EXPIRES } from './kit.ts';

const database = databaseFixture(createTestDatabase);

for (const platform of ['taobao', 'pdd'] as const) {
  for (const status of ['active', 'expiring']) {
    it(`[AC-S1-65#10] linking ${platform}/${status} 注入时钟到期那一毫秒即不放行，空日期只看状态`, async () => {
      const h = {
        db: database(),
        appId: `auth-guard-${randomUUID()}`,
        clock: new FixedClock(EXPIRES),
      };
      const a = await account(h, { platform, auth_status: status });
      const reads = createUnionAuthReads({
        db: h.db,
        clock: h.clock,
        appEnv: 'test',
        config: { configValue: async () => null },
        pids: { getActivePid: async () => null },
      });
      h.clock.advanceMs(-1);
      expect(await reads.siteAuthAvailable(h.appId, platform, a.id)).toBe(true);
      h.clock.advanceMs(1);
      expect(await reads.siteAuthAvailable(h.appId, platform, a.id)).toBe(false);
      await h.db
        .updateTable('union_accounts')
        .set({ auth_expires_at: null })
        .where('id', '=', a.id)
        .execute();
      expect(await reads.siteAuthAvailable(h.appId, platform, a.id)).toBe(true);
      await h.db
        .updateTable('union_accounts')
        .set({ auth_status: 'expired' })
        .where('id', '=', a.id)
        .execute();
      expect(await reads.siteAuthAvailable(h.appId, platform, a.id)).toBe(false);
      expect(await reads.siteAuthAvailable('other-app', platform, a.id)).toBe(false);
    });
  }
}

for (const platform of ['taobao', 'jd', 'pdd'] as const) {
  it(`[AC-S1-65#11] union sync ${platform} 时间守卫即时生效，读操作不写状态`, async () => {
    const h = {
      db: database(),
      appId: `auth-guard-${randomUUID()}`,
      clock: new FixedClock(EXPIRES),
    };
    const a = await account(h, { platform });
    const { logger } = memoryLogger('worker');
    const access = createUnionSyncAccess({
      db: h.db,
      clock: h.clock,
      endpoints: [],
      breaker: () => 'closed',
      logger,
    });
    const key = { app_id: h.appId, platform, union_account_id: a.id };
    h.clock.advanceMs(-1);
    expect(await access.siteAuthAvailable(key)).toBe(true);
    h.clock.advanceMs(1);
    expect(await access.siteAuthAvailable(key)).toBe(false);
    expect(
      await h.db
        .selectFrom('union_accounts')
        .selectAll()
        .where('id', '=', a.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(a);
    await h.db
      .updateTable('union_accounts')
      .set({ auth_expires_at: null })
      .where('id', '=', a.id)
      .execute();
    expect(await access.siteAuthAvailable(key)).toBe(true);
    await h.db
      .updateTable('union_accounts')
      .set({ auth_status: 'expired' })
      .where('id', '=', a.id)
      .execute();
    expect(await access.siteAuthAvailable(key)).toBe(false);
    expect(await access.siteAuthAvailable({ ...key, app_id: 'other-app' })).toBe(false);
  });
}
