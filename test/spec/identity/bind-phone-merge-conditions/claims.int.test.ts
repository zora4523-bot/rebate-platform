// B1-20e: merge condition「无订单（无已归因订单与找回申请）」 reads app.claims (规划/08 BR-ID-06 并号
// OPS-04; orchestrator ruling §9.2 item 1): any claim of the current account as the applicant, in
// this app, whatever its status, refuses the merge offer — 30411 only, no reason, no merge_ticket.
import { afterAll, beforeAll, it } from 'vitest';
import {
  closeKit,
  fixture,
  mergeable,
  occupied,
  openKit,
  type Kit,
} from '../bind-phone/http-kit.ts';
import { CLAIM_STATUSES, again, attempt, claim } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

for (const status of CLAIM_STATUSES) {
  it(`[AC-B1-20e#1] 第三方空号有一条 ${status} 的找回申请 → 只返回 30411（无 mergeable、无 ticket）`, async () => {
    const f = await fixture(kit, { method: 'wechat' });
    await f.owner();
    await claim(kit, f, f.uid, status);
    occupied(kit, await attempt(f));
  });
}

it('[AC-B1-20e#2] 找回申请只看当前账号作为申请人：目标账号与其他用户的申请不算，当前账号有一条已取消的申请即不并号', async () => {
  const f = await fixture(kit, { method: 'apple' });
  const target = await f.owner();
  const bystander = await f.owner({ to: `135${f.number.slice(3)}` });
  await claim(kit, f, target, 'submitted');
  await claim(kit, f, bystander, 'approved');
  mergeable(kit, await attempt(f));
  await claim(kit, f, f.uid, 'cancelled');
  occupied(kit, await again(kit, f));
});

it('[AC-B1-20e#3] 无订单、无找回申请的华为空号先可并号；补一条待审核申请后再绑同一号码 → 只返回 30411', async () => {
  const f = await fixture(kit, { method: 'huawei' });
  await f.owner();
  mergeable(kit, await attempt(f));
  await claim(kit, f, f.uid, 'manual_review');
  occupied(kit, await again(kit, f));
});
