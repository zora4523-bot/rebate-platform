import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import type { ActivePidInput } from '../../../../apps/api/src/modules/union/index.ts';
import { harness, seedAccount, seedPid } from '../pids/kit.ts';

export { outcome } from '../../linking/open-pdd-auth/kit.ts';
export { databaseFixture } from '../../linking/open-pdd-auth/database.ts';

/** Both accounts and all slots have distinct timestamps; UUID ordering never selects a winner. */
export async function accountSlots(
  db: Kysely<DB>,
  appId: string,
  platform: 'taobao' | 'pdd',
  accountId: string,
) {
  const h = { ...harness(db), appId };
  h.clock.set('2025-01-01T00:00:00.000Z');
  const other = await seedAccount(h, { platform, status: 'active' });
  h.clock.advanceMs(60_000);
  await db
    .updateTable('union_accounts')
    .set({ created_at: h.clock.now(), updated_at: h.clock.now() })
    .where('app_id', '=', appId)
    .where('id', '=', accountId)
    .execute();
  let sequence = 0;
  async function slots(account: string) {
    const rows = [];
    for (const pid_scene of ['self_buy', 'share', 'agent'] as const) {
      sequence += 1;
      h.clock.advanceMs(60_000);
      rows.push(
        await seedPid(h, {
          platform,
          union_account_id: account,
          pid_scene,
          status: 'active',
          pid: platform === 'taobao' ? `mm_990_880_${sequence}` : `synthetic-pdd-${sequence}`,
          site_id: platform === 'taobao' ? '880' : null,
        }),
      );
    }
    return { self_buy: rows[0]!, share: rows[1]!, agent: rows[2]! };
  }
  const b = await slots(other.id);
  const a = await slots(accountId);
  const getActivePid = vi.fn((input: ActivePidInput & { unionAccountId?: string }) =>
    h.service.getActivePid(input),
  );
  return { a, b, other, pids: { getActivePid } };
}
