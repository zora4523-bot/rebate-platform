import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { fixture } from '../bindings-pdd-query/kit.ts';
import type { BindingStatus } from '../open-pdd-auth/database.ts';
import { accountSlots } from '../../union/pids-by-account/kit.ts';

export { databaseFixture } from '../open-pdd-auth/database.ts';
export { listed, noSideEffects, snapshot, TIMEOUT } from '../bindings-pdd-query/kit.ts';

/** B 的账号和推广位更早，未按账号筛选必定取 B；时间戳由复用夹具明确错开。 */
export async function accountFixture(db: Kysely<DB>, status: BindingStatus = 'invalid') {
  const f = await fixture(db, status);
  const slots = await accountSlots(db, f.appId, 'pdd', f.accountId);
  // 两条路径共享真实读取：authAccountId 的兜底选择及备案身份的推广位选择。
  f.getActivePid.mockImplementation((input) => slots.pids.getActivePid(input));
  return { ...f, slots };
}
