// B3-03i 第 9 节 2：② 身份要求（BR-AI-11 细则表与正文「agent.require_phone（默认 false）」；两项置为收紧值
// 时的返回码在 BR-ID-03：require_phone=true 时未绑手机的登录用户 10005，guest_daily_quota=0 时游客 10001
// 而不是 30502）。require_phone 开时游客须先登录（10001）。读取失败时端口拒绝。
import { expect, it } from 'vitest';

import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { createAgentIdentityPort } from '../../../../apps/api/src/modules/agent/stream/access/index.ts';
import { APP, FakeConfig, OTHER_APP, guest, member } from './kit.ts';

type Who = 'guest' | 'unbound' | 'bound';
function caller(who: Who, appId = APP): AgentCaller {
  if (who === 'guest') return guest(appId);
  return member({ phoneBound: who === 'bound', appId });
}

it.each([
  { requirePhone: false, who: 'guest' as Who, expected: null },
  { requirePhone: false, who: 'unbound' as Who, expected: null },
  { requirePhone: false, who: 'bound' as Who, expected: null },
  { requirePhone: true, who: 'guest' as Who, expected: { code: 10001 } },
  { requirePhone: true, who: 'unbound' as Who, expected: { code: 10005 } },
  { requirePhone: true, who: 'bound' as Who, expected: null },
])(
  '[AC-B3-03i#7][BR-AI-11][BR-ID-03] agent.require_phone=$requirePhone × $who → $expected',
  async (c) => {
    const config = new FakeConfig()
      .set(APP, 'agent.require_phone', c.requirePhone)
      .set(APP, 'agent.guest_daily_quota', 3);
    const port = createAgentIdentityPort({ reader: config });
    expect(await port.check(caller(c.who))).toEqual(c.expected);
  },
);

it('[AC-B3-03i#8][BR-AI-11] require_phone 缺键按默认 false：三种身份都放行；只有 JSON 布尔 true 才算开', async () => {
  const port = createAgentIdentityPort({ reader: new FakeConfig() });
  for (const who of ['guest', 'unbound', 'bound'] as const) {
    expect(await port.check(caller(who)), `missing: ${who}`).toBeNull();
  }
  const on = createAgentIdentityPort({
    reader: new FakeConfig().set(APP, 'agent.require_phone', true),
  });
  expect(await on.check(caller('unbound')), 'boolean true').toEqual({ code: 10005 });
});

it('[AC-B3-03i#9][BR-ID-03] 法务收紧开关 agent.guest_daily_quota=0：游客 10001（不是 30502）；已绑手机照常放行；额度大于 0 时游客放行', async () => {
  const zero = createAgentIdentityPort({
    reader: new FakeConfig()
      .set(APP, 'agent.require_phone', false)
      .set(APP, 'agent.guest_daily_quota', 0),
  });
  expect(await zero.check(caller('guest')), 'guest, quota 0').toEqual({ code: 10001 });
  expect(await zero.check(caller('bound')), 'bound, quota 0').toBeNull();
  const three = createAgentIdentityPort({
    reader: new FakeConfig()
      .set(APP, 'agent.require_phone', false)
      .set(APP, 'agent.guest_daily_quota', 3),
  });
  expect(await three.check(caller('guest')), 'guest, quota 3').toBeNull();
});

it('[AC-B3-03i#10][BR-AI-11] 按调用方的 app_id 读开关；读取失败时端口拒绝（reject），不放行', async () => {
  const config = new FakeConfig()
    .set(APP, 'agent.require_phone', false)
    .set(OTHER_APP, 'agent.require_phone', true);
  const port = createAgentIdentityPort({ reader: config });
  expect(await port.check(caller('unbound', APP)), APP).toBeNull();
  expect(await port.check(caller('unbound', OTHER_APP)), OTHER_APP).toEqual({ code: 10005 });
  config.fail = true;
  for (const who of ['guest', 'unbound'] as const) {
    let rejected = false;
    let answer: unknown = 'not settled';
    try {
      answer = await port.check(caller(who));
    } catch (error) {
      rejected = true;
      expect(String(error)).not.toMatch(/NotImplemented/);
    }
    expect({ who, rejected, answer }).toEqual({ who, rejected: true, answer: 'not settled' });
  }
});
