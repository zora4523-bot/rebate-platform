// 规则测试（B1-12z；契约 CT-24t adminListNotifyChannels；08 BR-TEXT-20 细则「短信渠道登记与后台渠道
// 开关」、BR-TEXT-09 细则渠道列、BR-ID-05 有效期；编排裁定 D10-337 ②④、D10-339 ⑥、D10-341）：
// 列表每个模板编码一项、按 code 排序；可改性、资金类、短信就绪、sms_state、部署配置兜底、有效期、
// 各变体的在用 / 「待测试」登记；读只要 content.article 或 notify.channels 任一、不要动态码、不写审计。
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import {
  ALERT_ACTIVE,
  ARTICLE,
  BASE,
  CHANNELS,
  CODE_TTL_SEC,
  DENIED,
  FUND,
  ROUTES,
  SEEDED_TESTED_AT,
  SMS_CODE_ACTIVE,
  WD_FAILED_ACTIVE,
  WD_FAILED_PENDING,
  WD_REJECTED_ACTIVE,
  accepted,
  audits,
  itemOf,
  listed,
  ms,
  pendingOf,
  rejected,
  seedTemplate,
  setup,
  signIn,
  snapshot,
  sorted,
  variantOf,
  type Item,
  type Op,
  type PendingRegistration,
  type Registration,
  type Scenario,
  type Where,
} from './kit.ts';

const h = useHarness();

const WD_REJECTED_PENDING = pendingOf(WD_REJECTED_ACTIVE, 'accepted', 'SMS_540000003');
const WD_NEGATIVE_PENDING = pendingOf(
  {
    signName: '凑狸',
    templateCode: 'SMS_540000004',
    type: 'notice',
    preview: '【凑狸】你的提现未通过：${reason}；抵扣后的余额以钱包显示为准。',
  },
  'not_sent_no_verify_phone',
);

/** 六个编码：SMS_CODE 无登记、站长告警有登记、WD_FAILED 在用 + 测试失败、WD_REJECTED 两变体只有待测试、两个只发站内信的编码。 */
async function seedCatalog(s: Where) {
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    channels: ['push', 'inbox'],
    pending: WD_REJECTED_PENDING,
    rowVersion: 4,
  });
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    variant: 'negative_balance',
    channels: ['push', 'inbox'],
    pending: WD_NEGATIVE_PENDING,
    rowVersion: 4,
  });
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    pending: WD_FAILED_PENDING,
    rowVersion: 5,
  });
  await seedTemplate(s, { code: 'SMS_CODE', channels: ['sms'] });
  await seedTemplate(s, {
    code: 'UNION_AUTH_EXPIRING',
    channels: ['sms'],
    active: ALERT_ACTIVE,
    rowVersion: 2,
  });
  await seedTemplate(s, { code: 'BALANCE_ADJUSTED', channels: ['inbox'] });
  await seedTemplate(s, { code: 'RISK_STATE_CHANGED', channels: ['inbox'], rowVersion: 1 });
}

function activeView(registration: Registration) {
  return {
    sign_name: registration.signName,
    template_code: registration.templateCode,
    template_type: registration.type,
    preview_text: registration.preview,
    enabled_at: expect.any(String),
  };
}

function pendingView(registration: PendingRegistration) {
  return {
    sign_name: registration.signName,
    template_code: registration.templateCode,
    template_type: registration.type,
    preview_text: registration.preview,
    saved_at: expect.any(String),
    test: { status: registration.status, tested_at: expect.any(String) },
  };
}

/** 渠道列表不定顺序：两份渠道排序后再比。 */
const sortedChannels = (item: Item) => ({
  ...item,
  default_channels: sorted(item.default_channels),
  channels: sorted(item.channels),
});

it('[AC-B1-12z#1] 列表：每个模板编码一项、按 code 排序；只给本 app 的编码；不分页', async () => {
  const s = await setup(h);
  await seedCatalog(s);
  const items = await listed(s);
  expect(items.map((item) => item.code)).toEqual([
    'BALANCE_ADJUSTED',
    'RISK_STATE_CHANGED',
    'SMS_CODE',
    'UNION_AUTH_EXPIRING',
    'WD_FAILED',
    'WD_REJECTED',
  ]);
  const other = await setup(h);
  await seedTemplate(other, { code: 'WD_SUCCESS', channels: ['push', 'inbox'] });
  expect((await listed(other)).map((item) => item.code)).toEqual(['WD_SUCCESS']);
  expect((await listed(s)).map((item) => item.code)).toHaveLength(6);
});

it('[AC-B1-12z#2] 列表：SMS_CODE 无在用登记 → 只能换模板（sms_fixed）、不能开推送、部署配置兜底、短信照发（enabled）、未就绪、有效期 = BR-ID-05 的 300 秒、一行 default 变体变量 [code]', async () => {
  const s = await setup(h);
  await seedCatalog(s);
  expect(sortedChannels(await itemOf(s, 'SMS_CODE'))).toEqual({
    code: 'SMS_CODE',
    category: 'service',
    default_channels: ['sms'],
    channels: ['sms'],
    push_switchable: false,
    sms_switchable: false,
    sms_fixed: true,
    sms_billing_confirm: false,
    fund_terms: false,
    sms_ready: false,
    sms_state: 'enabled',
    sms_deploy_fallback: true,
    sms_code_ttl_sec: CODE_TTL_SEC,
    sms_registrations: [{ variant: 'default', variables: ['code'], active: null, pending: null }],
    row_version: 0,
  });
});

it('[AC-B1-12z#3] 列表：WD_FAILED（默认推送 + 站内 + 短信，资金类）在用登记生效、「待测试」测试失败照列；就绪、enabled、不需计费确认、row_version 取该编码的版本', async () => {
  const s = await setup(h);
  await seedCatalog(s);
  const item = await itemOf(s, 'WD_FAILED');
  expect(sortedChannels(item)).toEqual({
    code: 'WD_FAILED',
    category: 'service',
    default_channels: ['inbox', 'push', 'sms'],
    channels: ['inbox', 'push', 'sms'],
    push_switchable: true,
    sms_switchable: true,
    sms_fixed: false,
    sms_billing_confirm: false,
    fund_terms: true,
    sms_ready: true,
    sms_state: 'enabled',
    sms_deploy_fallback: false,
    sms_code_ttl_sec: null,
    sms_registrations: [
      {
        variant: 'default',
        variables: expect.arrayContaining(['amount']),
        active: activeView(WD_FAILED_ACTIVE),
        pending: pendingView(WD_FAILED_PENDING),
      },
    ],
    row_version: 5,
  });
  expect(ms(variantOf(item).pending?.test.tested_at)).toBe(SEEDED_TESTED_AT.getTime());
});

it('[AC-B1-12z#4] 列表：WD_REJECTED（默认推送 + 站内）每个变体一行；只有「待测试」登记（受理 / 未发送）不算就绪，短信关着为 disabled，打开短信要计费确认', async () => {
  const s = await setup(h);
  await seedCatalog(s);
  const item = await itemOf(s, 'WD_REJECTED');
  const { sms_registrations: rows, ...rest } = sortedChannels(item);
  expect(rest).toEqual({
    code: 'WD_REJECTED',
    category: 'service',
    default_channels: ['inbox', 'push'],
    channels: ['inbox', 'push'],
    push_switchable: true,
    sms_switchable: true,
    sms_fixed: false,
    sms_billing_confirm: true,
    fund_terms: true,
    sms_ready: false,
    sms_state: 'disabled',
    sms_deploy_fallback: false,
    sms_code_ttl_sec: null,
    row_version: 4,
  });
  expect([...rows].sort((a, b) => a.variant.localeCompare(b.variant))).toEqual([
    {
      variant: 'default',
      variables: expect.arrayContaining(['reason', 'amount']),
      active: null,
      pending: pendingView(WD_REJECTED_PENDING),
    },
    {
      variant: 'negative_balance',
      variables: expect.arrayContaining(['reason']),
      active: null,
      pending: pendingView(WD_NEGATIVE_PENDING),
    },
  ]);
});

it('[AC-B1-12z#5] 列表：站长告警（无站内信）只能换模板、不能开推送；有在用登记 → 就绪、enabled、不走部署配置；变量 platform_name、expires_at；资金类 false', async () => {
  const s = await setup(h);
  await seedCatalog(s);
  const item = await itemOf(s, 'UNION_AUTH_EXPIRING');
  expect(item).toMatchObject({
    code: 'UNION_AUTH_EXPIRING',
    default_channels: ['sms'],
    channels: ['sms'],
    push_switchable: false,
    sms_switchable: false,
    sms_fixed: true,
    sms_billing_confirm: false,
    fund_terms: false,
    sms_ready: true,
    sms_state: 'enabled',
    sms_deploy_fallback: false,
    sms_code_ttl_sec: null,
    row_version: 2,
  });
  const row = variantOf(item);
  expect(sorted(row.variables)).toEqual(['expires_at', 'platform_name']);
  expect(row.active).toEqual(activeView(ALERT_ACTIVE));
  expect(row.pending).toBeNull();
});

it('[AC-B1-12z#6] 列表：只发站内信的编码（BALANCE_ADJUSTED、RISK_STATE_CHANGED）两个开关都不能动、没有短信行、disabled', async () => {
  const s = await setup(h);
  await seedCatalog(s);
  for (const [code, rowVersion] of [
    ['BALANCE_ADJUSTED', 0],
    ['RISK_STATE_CHANGED', 1],
  ] as const) {
    expect(await itemOf(s, code), code).toEqual({
      code,
      category: 'service',
      default_channels: ['inbox'],
      channels: ['inbox'],
      push_switchable: false,
      sms_switchable: false,
      sms_fixed: false,
      sms_billing_confirm: false,
      fund_terms: true,
      sms_ready: false,
      sms_state: 'disabled',
      sms_deploy_fallback: false,
      sms_code_ttl_sec: null,
      sms_registrations: [],
      row_version: rowVersion,
    });
  }
});

it('[AC-B1-12z#7] 列表 sms_state / sms_ready / 兜底：默认含短信而未登记（待测试不算）→ enabled_not_ready；部分变体登记 → 未就绪；SMS_CODE 有在用登记 → 不再兜底；关掉短信的就绪编码 → disabled', async () => {
  const s = await setup(h);
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    pending: pendingOf(WD_FAILED_PENDING, 'accepted'),
  });
  await seedTemplate(s, {
    code: 'SMS_CODE',
    channels: ['sms'],
    active: SMS_CODE_ACTIVE,
    rowVersion: 3,
  });
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    channels: ['push', 'inbox'],
    active: WD_REJECTED_ACTIVE,
  });
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    variant: 'negative_balance',
    channels: ['push', 'inbox'],
  });
  await seedTemplate(s, { code: 'UNION_AUTH_EXPIRED', channels: ['sms'] });
  const pick = (item: Item) => ({
    sms_ready: item.sms_ready,
    sms_state: item.sms_state,
    sms_deploy_fallback: item.sms_deploy_fallback,
  });
  expect(pick(await itemOf(s, 'WD_FAILED'))).toEqual({
    sms_ready: false,
    sms_state: 'enabled_not_ready',
    sms_deploy_fallback: false,
  });
  expect(pick(await itemOf(s, 'WD_REJECTED'))).toEqual({
    sms_ready: false,
    sms_state: 'disabled',
    sms_deploy_fallback: false,
  });
  expect(pick(await itemOf(s, 'UNION_AUTH_EXPIRED'))).toEqual({
    sms_ready: false,
    sms_state: 'enabled_not_ready',
    sms_deploy_fallback: false,
  });
  const smsCode = await itemOf(s, 'SMS_CODE');
  expect(pick(smsCode)).toEqual({
    sms_ready: true,
    sms_state: 'enabled',
    sms_deploy_fallback: false,
  });
  expect(variantOf(smsCode).active).toEqual(activeView(SMS_CODE_ACTIVE));

  const off = await setup(h);
  await seedTemplate(off, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox'],
    active: WD_FAILED_ACTIVE,
    rowVersion: 7,
  });
  expect(pick(await itemOf(off, 'WD_FAILED'))).toEqual({
    sms_ready: true,
    sms_state: 'disabled',
    sms_deploy_fallback: false,
  });
});

for (const grants of [[ARTICLE], [CHANNELS], [ARTICLE, CHANNELS]]) {
  it(`[AC-B1-12z#8] 列表读权限：授予 ${JSON.stringify(grants)} 即可读，不要动态码；读不写审计`, async () => {
    const s = await setup(h, { grants });
    await seedCatalog(s);
    expect((await listed(s)).map((item) => item.code)).toHaveLength(6);
    expect(await audits(s)).toEqual([]);
  });
}

it('[AC-B1-12z#9] 列表读权限：只有 content.fund_terms 或什么都没有 → 10403 admin_permission_denied（带动态码也不行）', async () => {
  for (const grants of [[FUND], []]) {
    const s = await setup(h, { grants });
    await seedCatalog(s);
    await rejected(await s.list(), 'list', 10403, DENIED);
    await rejected(await s.list({ 'x-step-up-token': await s.issue() }), 'list', 10403, DENIED);
  }
});

it('[AC-B1-12z#10] 列表：读不消耗动态码——带着读过的令牌仍可完成一次写操作；超管不勾权限点也能读', async () => {
  const s = await setup(h);
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    rowVersion: 5,
  });
  const token = await s.issue();
  const read = await accepted<{ items: Item[] }>(
    await s.list({ 'x-step-up-token': token }),
    'list',
  );
  expect(read.items).toHaveLength(1);
  const switched = await accepted<Item>(
    await s.switchChannels('WD_FAILED', { push: false, row_version: 5 }, { token }),
    'switch',
  );
  expect(switched.row_version).toBe(6);

  const root = await signIn(h, s.f, s.appId, { grants: [], isSuper: true });
  expect((await listed(root)).map((item) => item.code)).toEqual(['WD_FAILED']);
});

it('[AC-B1-12z#11] 六个接口都要后台令牌，缺失为 10001，什么都不写', async () => {
  const s = await setup(h);
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    pending: pendingOf(WD_FAILED_PENDING, 'accepted'),
    rowVersion: 5,
  });
  const before = await snapshot(s);
  const json = { 'content-type': 'application/json' };
  const requests: [Parameters<Scenario['inject']>[0], Op][] = [
    [{ method: 'GET', url: BASE }, 'list'],
    [
      {
        method: 'PATCH',
        url: `${BASE}/WD_FAILED`,
        headers: { ...json, 'x-step-up-token': await s.issue() },
        payload: JSON.stringify({ push: false, row_version: 5 }),
      },
      'switch',
    ],
    [
      {
        method: 'PUT',
        url: `${BASE}/WD_FAILED/sms`,
        headers: { ...json, 'x-step-up-token': await s.issue() },
        payload: JSON.stringify({
          sign_name: '凑狸',
          template_code: 'SMS_520000009',
          template_type: 'notice',
          preview_text: WD_FAILED_ACTIVE.preview,
          row_version: 5,
        }),
      },
      'register',
    ],
    [{ method: 'DELETE', url: `${BASE}/WD_FAILED/sms/pending?row_version=5` }, 'discard'],
    [
      {
        method: 'POST',
        url: `${BASE}/WD_FAILED/sms/pending/test`,
        headers: { ...json, 'x-step-up-token': await s.issue() },
        payload: JSON.stringify({ row_version: 5 }),
      },
      'retest',
    ],
    [
      {
        method: 'POST',
        url: `${BASE}/WD_FAILED/sms/pending/enable`,
        headers: { ...json, 'x-step-up-token': await s.issue() },
        payload: JSON.stringify({ row_version: 5 }),
      },
      'enable',
    ],
  ];
  for (const [request, op] of requests) {
    await rejected(await s.inject(request), op, 10001);
    expect(await snapshot(s), op).toEqual(before);
  }
});

it('[AC-B1-12z#12] 只有后台入口装配这六个接口，api 入口没有', async () => {
  const s = await setup(h);
  expect(await listed(s)).toEqual([]);
  const api = await fixture(h, { entry: 'api' });
  const server = api.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  for (const [method, url] of ROUTES) {
    expect(server.hasRoute({ method, url }), `${method} ${url} on api`).toBe(false);
  }
});
