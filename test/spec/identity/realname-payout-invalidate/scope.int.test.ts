// B1-27g · only the corrected user's accounts of the corrected app (08 BR-WDR-02 细则「实名更正后的失效
// 与重绑」「该用户的收款账号全部失效」; 规划/02 §19 app_id isolation; task §9.4): the exempt change row
// carries the app and user of the correction; another member of the same app and members of other
// apps keep their current accounts and change rows untouched. users.id is the primary key of
// app.users, so the same user_id cannot exist in a second app: the other app's member is a
// different user whose rows sit next to the corrected one's.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { OTHER, body, correct, ok, user, verified } from '../admin-realname/kit.ts';
import { EXEMPT, appIdOf, bound, change, payoutState, setup } from './kit.ts';

const h = useHarness();

it('[AC-B1-27g#10] 只失效被更正用户在本 App 的账号：exempt 行带本 App 与该用户；同 App 他人、其他 App 会员的账号与变更行不动', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  await bound(h, target, 'alipay', true, 'old.payee@example.com');
  const neighbour = await user(h, s.appId);
  await verified(h, neighbour, OTHER);
  await bound(h, neighbour, 'alipay', true, 'neighbour.payee@example.com', OTHER.name);
  await change(h, neighbour, s.clock.now());
  const otherApp = appIdOf('b127g_x');
  const stranger = await user(h, otherApp);
  await verified(h, stranger);
  // The same logon id as the corrected user's, bound in the other app.
  await bound(h, stranger, 'alipay', true, 'old.payee@example.com');
  await change(h, stranger, s.clock.now());
  const others = {
    neighbour: await payoutState(h, neighbour),
    stranger: await payoutState(h, stranger),
  };

  await ok(await correct(s, target.id, body()));
  const after = await payoutState(h, target);
  expect(after.accounts.filter((account) => account.is_current)).toEqual([]);
  expect(after.changes).toHaveLength(1);
  expect(after.changes[0]).toMatchObject({
    app_id: s.appId,
    user_id: target.id,
    limit_exempt_reason: EXEMPT,
  });
  expect({
    neighbour: await payoutState(h, neighbour),
    stranger: await payoutState(h, stranger),
  }).toEqual(others);
});
