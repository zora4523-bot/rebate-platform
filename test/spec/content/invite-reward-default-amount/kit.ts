// F1-02zza: reuse frozen HTTP/SQL helpers, with a task-local app_id containing only [a-z0-9_].
// These helpers run only in the orchestrator's integration container.
import { randomUUID } from 'node:crypto';
import { seed } from '../../admin/accounts/kit.ts';
import { fixture, signedIn, type Harness } from '../../admin/auth/kit.ts';
import { putRow } from '../config-items/kit.ts';
import { DAILY, TOTAL } from '../invite-reward-config/oracle.ts';

export {
  checkRejected,
  checkSuccess,
  current,
  enable,
  prepare,
  putRow,
  snapshot,
  unchanged,
  useHarness,
} from '../invite-reward-config/kit.ts';
export { AMOUNT, DAILY, ENABLED, TOTAL } from '../invite-reward-config/oracle.ts';

export async function setup(h: Harness) {
  const f = await fixture(h);
  const appId = `f1_02zza_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  return { ...f, appId, actor, token: session.admin_token };
}

export async function budgets(h: Harness, f: { appId: string }) {
  await putRow(h, f.appId, DAILY, 100);
  await putRow(h, f.appId, TOTAL, 100);
}
