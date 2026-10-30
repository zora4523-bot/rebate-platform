// B1-20e: merge condition「目标手机号账号未处于注销流程」 reads the deletion stage (规划/08 BR-ID-06
// 并号 OPS-04; orchestrator ruling §9.2 item 3): a target account in the cooling period or in
// processing (identity's deletion stage, deletion_requests cooling / processing) refuses the merge
// offer — 30411 only. The target keeps users.status = normal here, so only the stage can refuse
// (users.status = deleting is B1-20a's case #30).
import { afterAll, beforeAll, it } from 'vitest';
import {
  closeKit,
  fixture,
  mergeable,
  occupied,
  openKit,
  type Kit,
} from '../bind-phone/http-kit.ts';
import { again, attempt, deletion } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it('[AC-B1-20e#13] 目标手机号账号处于注销冷静期（deletion_requests cooling）→ 只返回 30411（无 mergeable、无 ticket）', async () => {
  const f = await fixture(kit, { method: 'wechat' });
  const target = await f.owner();
  await deletion(kit, f, target, 'cooling');
  occupied(kit, await attempt(f));
});

it('[AC-B1-20e#14] 目标账号冷静期已到期、任务尚未处理（仍是 cooling）→ 只返回 30411', async () => {
  const f = await fixture(kit, { method: 'apple' });
  const target = await f.owner();
  await deletion(kit, f, target, 'overdue_cooling');
  occupied(kit, await attempt(f));
});

it('[AC-B1-20e#15] 目标账号注销处理中（deletion_requests processing）→ 只返回 30411', async () => {
  const f = await fixture(kit, { method: 'huawei' });
  const target = await f.owner();
  await deletion(kit, f, target, 'processing');
  occupied(kit, await attempt(f));
});

it('[AC-B1-20e#16] 目标账号只有已撤回的注销申请、别的用户在冷静期 → 可并号；目标账号再次申请注销后 → 只返回 30411', async () => {
  const f = await fixture(kit, { method: 'wechat' });
  const target = await f.owner();
  const bystander = await f.owner({ to: `135${f.number.slice(3)}` });
  await deletion(kit, f, target, 'cancelled');
  await deletion(kit, f, bystander, 'cooling');
  mergeable(kit, await attempt(f));
  await deletion(kit, f, target, 'cooling');
  occupied(kit, await again(kit, f));
});
