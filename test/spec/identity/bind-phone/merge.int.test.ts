// B1-20a: the merge offer of 30411 (规划/08 BR-ID-06 并号条件; 10 AC-S1-59 ①④⑤, AC-S1-130 ①;
// 02 §18「并号」; orchestrator ruling §9.3 items 3–6). Real AppModule over PG and Redis; the claim
// and ledger answers and the merge_ticket namespace are switched through the kit's seams only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TICKET_TTL_MS,
  closeKit,
  envelope,
  fixture,
  mergeable,
  occupied,
  openKit,
  quiet,
  storedTicket,
  type Fixture,
  type Kit,
} from './http-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

/** The current account binds the number another account owns; nothing may move on either side. */
async function attempt(f: Fixture) {
  const code = await f.send();
  const before = await f.snapshot();
  const response = await f.bind({ phone: f.number, code });
  expect(await f.snapshot()).toEqual(before);
  expect(await f.stillValid(code)).toBe(false);
  return { response, code };
}

for (const method of ['wechat', 'apple', 'huawei'] as const) {
  it(`[AC-B1-20a#20] AC-S1-59 ① ${method} 空号绑定他人号 → 30411 mergeable，ticket 存 Redis 5 分钟`, async () => {
    const f = await fixture(kit, { method });
    const target = await f.owner();
    const { response } = await attempt(f);
    const ticket = mergeable(kit, response);
    const stored = await storedTicket(kit, ticket);
    expect(stored.value).not.toBeNull();
    expect(JSON.parse(stored.value!)).toEqual({
      app_id: f.appId,
      uid: f.uid,
      phone_hmac: f.hmac(),
    });
    expect(stored.pttl).toBeGreaterThan(TICKET_TTL_MS - 15_000);
    expect(stored.pttl).toBeLessThanOrEqual(TICKET_TTL_MS);
    // The key is the ticket's SHA-256, never the ticket itself.
    expect(stored.raw).toBeNull();
    expect((await f.user()).phone_hmac).toBeNull();
    expect((await f.user(target)).phone_hmac).toBe(f.hmac());
    quiet(kit, f.number, ticket);
  });
}

it('[AC-B1-20a#21] 两次并号提示的 ticket 各不相同、各自绑定当前 uid', async () => {
  const a = await fixture(kit);
  await a.owner();
  const first = mergeable(kit, (await attempt(a)).response);
  const b = await fixture(kit);
  await b.owner();
  const second = mergeable(kit, (await attempt(b)).response);
  expect(second).not.toBe(first);
  expect(JSON.parse((await storedTicket(kit, first)).value!)).toMatchObject({ uid: a.uid });
  expect(JSON.parse((await storedTicket(kit, second)).value!)).toMatchObject({ uid: b.uid });
});

it('[AC-B1-20a#22] 同一幂等键重放返回原 30411 与同一 ticket', async () => {
  const f = await fixture(kit);
  await f.owner();
  const code = await f.send();
  const key = randomUUID();
  const ticket = mergeable(kit, await f.bind({ phone: f.number, code }, { key }));
  const before = await f.snapshot();
  const replay = await f.bind({ phone: f.number, code }, { key });
  expect(mergeable(kit, replay)).toBe(ticket);
  expect(await f.snapshot()).toEqual(before);
  expect(JSON.parse((await storedTicket(kit, ticket)).value!)).toEqual({
    app_id: f.appId,
    uid: f.uid,
    phone_hmac: f.hmac(),
  });
});

it('[AC-B1-20a#23] AC-S1-59 ④ Apple 新号已有 1 笔订单 → 只返回 30411', async () => {
  const f = await fixture(kit, { method: 'apple' });
  await f.order();
  await f.owner();
  occupied(kit, (await attempt(f)).response);
});

it('[AC-B1-20a#24] AC-S1-59 ⑤ / AC-S1-130 ① 目标账号已绑同一 provider（微信）→ 只返回 30411', async () => {
  const f = await fixture(kit, { method: 'wechat' });
  const target = await f.owner();
  await f.oauth(target, 'wechat');
  occupied(kit, (await attempt(f)).response);
});

it('[AC-B1-20a#25] 目标账号只绑了别的 provider（Apple），微信空号仍可并号', async () => {
  const f = await fixture(kit, { method: 'wechat' });
  const target = await f.owner();
  await f.oauth(target, 'apple');
  mergeable(kit, (await attempt(f)).response);
});

it('[AC-B1-20a#26] 当前账号有上级 → 只返回 30411', async () => {
  const f = await fixture(kit);
  const parent = await f.owner({ to: `135${f.number.slice(3)}` });
  await f.setParent(f.uid, parent);
  await f.owner();
  occupied(kit, (await attempt(f)).response);
});

it('[AC-B1-20a#27] 当前账号有下级 → 只返回 30411', async () => {
  const f = await fixture(kit);
  const child = await f.owner({ to: `136${f.number.slice(3)}` });
  await f.setParent(child, f.uid);
  await f.owner();
  occupied(kit, (await attempt(f)).response);
});

it('[AC-B1-20a#28] 目标账号被封禁 → 只返回 30411', async () => {
  const f = await fixture(kit);
  const target = await f.owner();
  await f.setRisk(target, 'banned');
  occupied(kit, (await attempt(f)).response);
});

it('[AC-B1-20a#29] 目标账号封禁后申诉中（appealing，申诉前 banned）仍算封禁 → 只返回 30411', async () => {
  const f = await fixture(kit);
  const target = await f.owner();
  await f.setRisk(target, 'banned');
  await f.appeal(target, 'banned');
  await f.setRisk(target, 'appealing');
  occupied(kit, (await attempt(f)).response);
});

it('[AC-B1-20a#30] 目标账号处于注销流程（deleting）→ 只返回 30411', async () => {
  const f = await fixture(kit);
  await f.owner({ status: 'deleting' });
  occupied(kit, (await attempt(f)).response);
});

it('[AC-B1-20a#31] 当前账号不是第三方注册（短信注册、无手机号）→ 只返回 30411', async () => {
  const f = await fixture(kit, { method: 'sms' });
  await f.owner();
  occupied(kit, (await attempt(f)).response);
});

for (const fault of ['claims', 'ledger'] as const) {
  it(`[AC-B1-20a#32] 端口报告当前账号有${fault === 'claims' ? '找回申请' : '余额流水'} → 只返回 30411`, async () => {
    const f = await fixture(kit);
    await f.owner();
    kit.faults[fault] = true;
    try {
      occupied(kit, (await attempt(f)).response);
    } finally {
      kit.faults[fault] = false;
    }
  });
}

it('[AC-B1-20a#33] 装配的端口缺省：无找回申请、无余额流水时空号可并号', async () => {
  const f = await fixture(kit);
  await f.owner();
  expect(kit.faults).toEqual({ ticketStore: false, claims: false, ledger: false });
  mergeable(kit, (await attempt(f)).response);
});

it('[AC-B1-20a#34] merge_ticket 存储不可用 → 50001，不回 mergeable、不绑定', async () => {
  const f = await fixture(kit);
  const target = await f.owner();
  const code = await f.send();
  const before = await f.snapshot();
  kit.faults.ticketStore = true;
  const response = await f.bind({ phone: f.number, code }).finally(() => {
    kit.faults.ticketStore = false;
  });
  const body = envelope(kit, response, 50001);
  expect(body.data?.['reason']).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('merge_ticket');
  expect(await f.snapshot()).toEqual(before);
  expect((await f.user()).phone_hmac).toBeNull();
  expect((await f.user(target)).phone_hmac).toBe(f.hmac());
  quiet(kit, f.number);
});
