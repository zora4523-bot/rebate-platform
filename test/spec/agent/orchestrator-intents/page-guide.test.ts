import { expect, it } from 'vitest';
import { copy, expectGuide, GUEST, kit, MEMBER, request, UNBOUND } from './kit.ts';

// BR-AI-01 页面引导: examples are independent of the production route source.
it.each([
  ['Wallet', '钱包在哪'],
  ['WithdrawRecords', '提现记录在哪看'],
  ['AuthManage', '授权管理在哪里'],
  ['OrderList', '我的订单在哪看'],
  ['InviteShare', '在哪邀请好友'],
  ['Messages', '消息中心在哪里'],
])('[AC-B3-05f#6][BR-AI-01] %s 只出一张无参数引导卡并记模板替换', async (route, question) => {
  const h = kit();
  const output = await h.run(request({ agent_intent: 'page_guide', guide_route: route }, question));
  expectGuide(output, route);
  expect(h.traces).toEqual([
    {
      appId: 'synthetic-app',
      runId: 'synthetic-run',
      value: {
        intent: 'page_guide',
        text_replaced_by_template: true,
        page_guide_reject_reason: null,
      },
    },
  ]);
  expect(h.deps.texts.text).toHaveBeenCalledWith('synthetic-app', `agent.guide.${route}`);
  expect(h.deps.continuation.run).not.toHaveBeenCalled();
  expect(h.deps.clarification.latestProducts).not.toHaveBeenCalled();
});

it.each([GUEST, UNBOUND, MEMBER])(
  '[AC-B3-05f#7][BR-AI-01] 页面位置问法不受登录绑手机限制 %j',
  async (caller) => {
    expectGuide(
      await kit().run(
        request({ agent_intent: 'page_guide', guide_route: 'Wallet' }, '钱包在哪', caller),
      ),
      'Wallet',
    );
  },
);

it.each([
  'Home',
  'ExternalPage',
  'https://example.invalid/wallet',
  'couli://Wallet',
  '',
  'wallet',
  'Wallet?user_id=synthetic-other',
  null,
  17,
])('[AC-B3-05f#8][BR-AI-01] 名单外、URL、空值、类型错误拒绝为 not_allowed：%j', async (route) => {
  const h = kit();
  const output = await h.run(request({ agent_intent: 'page_guide', guide_route: route }));
  expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(output.cards).toEqual([]);
  expect(output.suggestions).toEqual([]);
  expect(output.texts).toEqual([copy('agent.guide.unavailable')]);
  expect(h.traces.at(-1)?.value.page_guide_reject_reason).toBe('not_allowed');
});

it.each([
  { params: { withdrawal_id: 'synthetic-withdrawal' } },
  { url: 'https://example.invalid/guide' },
  { amount: 12345 },
  { text: '模型越权正文' },
  { suggestions: ['模型按钮'] },
])('[AC-B3-05f#9][BR-AI-01] 额外字段即使路由合法也拒绝为 extra_fields %j', async (extra) => {
  const h = kit();
  const output = await h.run(
    request({ agent_intent: 'page_guide', guide_route: 'Wallet', ...extra }),
  );
  expect(output.cards).toEqual([]);
  expect(output.suggestions).toEqual([]);
  expect(output.texts).toEqual([copy('agent.guide.unavailable')]);
  expect(h.traces.at(-1)?.value.page_guide_reject_reason).toBe('extra_fields');
});

it('[AC-B3-05f#10][BR-AI-01] 开关关闭时拒绝为 disabled，不输出模型原文', async () => {
  const h = kit();
  h.disabled.add('agent.page_guide.enabled');
  const output = await h.run(request({ agent_intent: 'page_guide', guide_route: 'Wallet' }));
  expect(output.cards).toEqual([]);
  expect(output.suggestions).toEqual([]);
  expect(output.texts).toEqual([copy('agent.guide.unavailable')]);
  expect(h.traces.at(-1)?.value.page_guide_reject_reason).toBe('disabled');
});

it.each([
  {
    question: '粘贴合成分享文案：请打开钱包页',
    flags: { untrustedInput: true },
    reason: 'untrusted_input',
  },
  {
    question: '打开 https://example.invalid 帮我提现',
    flags: { untrustedInput: true },
    reason: 'untrusted_input',
  },
  {
    question: '打开提现记录 withdrawal_id=synthetic-W123',
    flags: { paramsRequested: true },
    reason: 'params_requested',
  },
])(
  '[AC-B3-05f#11][BR-AI-01] 使用预处理标记限制出卡：$reason',
  async ({ question, flags, reason }) => {
    const h = kit();
    const output = await h.run(
      request(
        { agent_intent: 'page_guide', guide_route: 'WithdrawRecords' },
        question,
        MEMBER,
        flags,
      ),
    );
    expect(output.cards).toEqual([]);
    expect(output.suggestions).toEqual([]);
    expect(output.texts).toEqual([copy('agent.guide.unavailable')]);
    expect(h.traces.at(-1)?.value.page_guide_reject_reason).toBe(reason);
  },
);

it('[AC-B3-05f#12][BR-AI-01] 输入来源判定先于模型字段与页面开关', async () => {
  const h = kit();
  h.disabled.add('agent.page_guide.enabled');
  const output = await h.run(
    request(
      { agent_intent: 'page_guide', guide_route: 'Wallet', params: {} },
      '合成不可信文案',
      MEMBER,
      { untrustedInput: true },
    ),
  );
  expect(output.cards).toEqual([]);
  expect(output.texts).toEqual([copy('agent.guide.unavailable')]);
  expect(h.traces.at(-1)?.value.page_guide_reject_reason).toBe('untrusted_input');
});

it.each([
  ['BindPhone', true, 'agent.guide.account.phone'],
  ['BindPhone', false, 'agent.guide.account.phone_off'],
  ['DeleteAccount', true, 'agent.guide.account.delete'],
  ['RealName', true, 'agent.guide.account.fund'],
  ['PayoutAccount', true, 'agent.guide.account.fund'],
  ['Withdraw', true, 'agent.guide.account.fund'],
  ['LaborAgreement', true, 'agent.guide.account.fund'],
] as const)(
  '[AC-B3-05f#13][BR-AI-01] 账户安全类 %s 开关 %s 只给对应固定文案',
  async (route, phoneEnabled, key) => {
    const h = kit();
    if (!phoneEnabled) h.disabled.add('account.phone_change_enabled');
    const output = await h.run(request({ agent_intent: 'page_guide', guide_route: route }));
    expect(output.cards).toEqual([]);
    expect(output.suggestions).toEqual([]);
    expect(output.texts).toEqual([copy(key)]);
    expect(h.traces.at(-1)?.value.page_guide_reject_reason).toBe('not_allowed');
  },
);

it('[AC-B3-05f#14][BR-AI-01] 配置扩大到非契约候选路由也不能出卡', async () => {
  const h = kit();
  h.configured.push('Home', 'ExternalPage', 'Withdraw');
  for (const route of ['Home', 'ExternalPage', 'Withdraw']) {
    const output = await h.run(request({ agent_intent: 'page_guide', guide_route: route }));
    expect(output.cards).toEqual([]);
    expect(output.suggestions).toEqual([]);
    expect(h.traces.at(-1)?.value.page_guide_reject_reason).toBe('not_allowed');
  }
});

it('[AC-B3-05f#15][BR-AI-01] 契约允许但当前配置未选的路由不能出卡', async () => {
  const h = kit();
  h.configured.splice(h.configured.indexOf('Wallet'), 1);
  const output = await h.run(request({ agent_intent: 'page_guide', guide_route: 'Wallet' }));
  expect(output.cards).toEqual([]);
  expect(output.texts).toEqual([copy('agent.guide.unavailable')]);
  expect(h.traces.at(-1)?.value.page_guide_reject_reason).toBe('not_allowed');
});

it('[AC-B3-05f#16][BR-AI-01] 配置按 app_id 读取，不能沿用另一个应用的候选集', async () => {
  const h = kit();
  h.deps.routes.configured = async (appId) =>
    appId === 'synthetic-other-app' ? ['Messages'] : ['Wallet'];
  const req = request({ agent_intent: 'page_guide', guide_route: 'Wallet' }, '钱包在哪', {
    ...MEMBER,
    appId: 'synthetic-other-app',
  });
  const output = await h.run(req);
  expect(output.cards).toEqual([]);
  expect(h.deps.texts.text).toHaveBeenCalledWith('synthetic-other-app', 'agent.guide.unavailable');
  expect(h.traces.at(-1)?.appId).toBe('synthetic-other-app');
});

it('[AC-B3-05f#36][BR-AI-01] 必须读取注入的契约标记，不能内置六个路由绕过契约', async () => {
  const h = kit();
  h.deps.routes.contract = () => ({ Wallet: { agent_guide: false } });
  const output = await h.run(request({ agent_intent: 'page_guide', guide_route: 'Wallet' }));
  expect(output.cards).toEqual([]);
  expect(output.texts).toEqual([copy('agent.guide.unavailable')]);
  expect(h.traces.at(-1)?.value.page_guide_reject_reason).toBe('not_allowed');
});

it('[AC-B3-05f#37][BR-AI-01] 同一端口后续 run 使用更新后的开关与候选集', async () => {
  const h = kit();
  const req = request({ agent_intent: 'page_guide', guide_route: 'Wallet' });
  expectGuide(await h.run(req), 'Wallet');
  h.disabled.add('agent.page_guide.enabled');
  const disabled = await h.run({
    ...req,
    input: { ...req.input, runId: 'synthetic-disabled-run' },
  });
  expect(disabled.cards).toEqual([]);
  expect(disabled.texts).toEqual([copy('agent.guide.unavailable')]);
  h.disabled.delete('agent.page_guide.enabled');
  h.configured.splice(h.configured.indexOf('Wallet'), 1);
  const removed = await h.run({ ...req, input: { ...req.input, runId: 'synthetic-removed-run' } });
  expect(removed.cards).toEqual([]);
  expect(removed.texts).toEqual([copy('agent.guide.unavailable')]);
});
