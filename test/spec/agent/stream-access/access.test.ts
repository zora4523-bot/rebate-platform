// B3-03i 第 9 节 1：① 开放与白名单（BR-AI-12；开放判定 = agent.enabled=on 且（agent.whitelist_only=off
// 或 user_id ∈ agent.whitelist_user_ids），BR-ID-03 细则、08 §13.2 C-29）。名单期间只许「已登录、已绑手机、
// 且在名单内」的用户（BR-AI-12），其他人一律 30501；agent.enabled=off 对所有人 30501。配置读取失败时端口
// 拒绝，不默认放行。开关值按 config_items 的 JSON 布尔（db/seeds 先例）。
import { expect, it } from 'vitest';

import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { createAgentAccessPort } from '../../../../apps/api/src/modules/agent/stream/access/index.ts';
import { APP, FakeConfig, OTHER_APP, guest, member, openConfig } from './kit.ts';

type Who = 'guest' | 'unbound' | 'bound';
function caller(who: Who, appId = APP): AgentCaller {
  if (who === 'guest') return guest(appId);
  return member({ phoneBound: who === 'bound', appId });
}

it.each([
  { whitelistOnly: false, who: 'guest' as Who },
  { whitelistOnly: false, who: 'unbound' as Who },
  { whitelistOnly: false, who: 'bound' as Who },
  { whitelistOnly: true, who: 'bound' as Who },
])(
  '[AC-B3-03i#1][BR-AI-12] agent.enabled=off：whitelist_only=$whitelistOnly 时 $who（名单内也一样）一律 30501',
  async (c) => {
    const who = caller(c.who);
    const config = new FakeConfig()
      .set(APP, 'agent.enabled', false)
      .set(APP, 'agent.whitelist_only', c.whitelistOnly)
      .set(APP, 'agent.whitelist_user_ids', who.userId === null ? [] : [who.userId]);
    const port = createAgentAccessPort({ reader: config });
    expect(await port.check(who)).toEqual({ code: 30501 });
  },
);

it('[AC-B3-03i#2][BR-AI-12] agent.enabled=on 且 whitelist_only=off（登记号已填、全开放）：游客、未绑手机、已绑手机都放行，不看名单', async () => {
  const port = createAgentAccessPort({ reader: openConfig() });
  for (const who of ['guest', 'unbound', 'bound'] as const) {
    expect(await port.check(caller(who)), who).toBeNull();
  }
});

it('[AC-B3-03i#3][BR-AI-12][BR-ID-03] whitelist_only=on（登记前）：游客、名单内但未绑手机、已绑手机但不在名单 → 30501；名单内且已绑手机 → 放行', async () => {
  const listedBound = member({ phoneBound: true });
  const listedUnbound = member({ phoneBound: false });
  const unlistedBound = member({ phoneBound: true });
  const visitor = guest();
  const config = new FakeConfig()
    .set(APP, 'agent.enabled', true)
    .set(APP, 'agent.whitelist_only', true)
    .set(APP, 'agent.whitelist_user_ids', [listedBound.userId, listedUnbound.userId]);
  const port = createAgentAccessPort({ reader: config });
  expect(await port.check(visitor), 'guest').toEqual({ code: 30501 });
  expect(await port.check(listedUnbound), 'listed, phone not bound').toEqual({ code: 30501 });
  expect(await port.check(unlistedBound), 'bound, not listed').toEqual({ code: 30501 });
  expect(await port.check(listedBound), 'listed and bound').toBeNull();
  // A guest whose device id happens to equal a listed user id is still a guest.
  expect(await port.check({ ...visitor, deviceId: listedBound.userId! })).toEqual({ code: 30501 });
});

it('[AC-B3-03i#4][BR-AI-12] 名单开关缺省按 on（登记前必须为 on）：whitelist_only 缺键时只放行名单内已绑手机用户；名单缺键或不是数组时谁都不在名单', async () => {
  const listed = member({ phoneBound: true });
  const config = new FakeConfig()
    .set(APP, 'agent.enabled', true)
    .set(APP, 'agent.whitelist_user_ids', [listed.userId]);
  const port = createAgentAccessPort({ reader: config });
  expect(await port.check(guest()), 'whitelist_only missing: guest').toEqual({ code: 30501 });
  expect(await port.check(member({ phoneBound: true })), 'not listed').toEqual({ code: 30501 });
  expect(await port.check(listed), 'listed').toBeNull();

  for (const ids of [undefined, listed.userId, { [listed.userId!]: true }]) {
    const c = new FakeConfig()
      .set(APP, 'agent.enabled', true)
      .set(APP, 'agent.whitelist_only', true);
    if (ids !== undefined) c.set(APP, 'agent.whitelist_user_ids', ids);
    const p = createAgentAccessPort({ reader: c });
    expect(await p.check(listed), `whitelist_user_ids ${JSON.stringify(ids)}`).toEqual({
      code: 30501,
    });
  }
});

it('[AC-B3-03i#5][BR-AI-12] 配置读取失败：端口拒绝（reject），不放行、不当作 30501 以外的结论', async () => {
  const config = openConfig();
  config.fail = true;
  const port = createAgentAccessPort({ reader: config });
  for (const who of ['guest', 'unbound', 'bound'] as const) {
    let answer: unknown = 'not settled';
    let rejected = false;
    try {
      answer = await port.check(caller(who));
    } catch (error) {
      rejected = true;
      expect(String(error)).not.toMatch(/NotImplemented/);
    }
    expect({ who, rejected, answer }).toEqual({ who, rejected: true, answer: 'not settled' });
  }
});

it('[AC-B3-03i#6][BR-AI-12] 按调用方的 app_id 读配置：另一品牌关闭或开名单不影响本品牌，反之亦然', async () => {
  const listed = member({ phoneBound: true, appId: OTHER_APP });
  const config = openConfig(APP)
    .set(OTHER_APP, 'agent.enabled', true)
    .set(OTHER_APP, 'agent.whitelist_only', true)
    .set(OTHER_APP, 'agent.whitelist_user_ids', [listed.userId]);
  const port = createAgentAccessPort({ reader: config });
  expect(await port.check(guest(APP)), 'open app').toBeNull();
  expect(await port.check(guest(OTHER_APP)), 'whitelisted app').toEqual({ code: 30501 });
  expect(await port.check(listed), 'listed in the whitelisted app').toBeNull();
  config.set(APP, 'agent.enabled', false);
  expect(await port.check(guest(APP)), 'disabled app').toEqual({ code: 30501 });
  expect(await port.check(listed), 'other app unaffected').toBeNull();
});
