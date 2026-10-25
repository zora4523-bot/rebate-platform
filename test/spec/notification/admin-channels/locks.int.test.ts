// 规则测试（B1-12z 第 2 次，spec-test r1 补充；契约 CT-24t adminListNotifyChannels / adminSwitchNotifyChannels /
// adminRegisterNotifySms / adminEnableNotifySms；08 BR-TEXT-20 细则「短信渠道登记与后台渠道开关」的范围、
// 模板类型锁定与测试发送，BR-TEXT-23 细则「个人信息副本的交付通知」；编排裁定 D10-337、D10-341）：
// - 订阅类编码不发短信：列表不能开关短信、没有短信行；开短信与登记都 notify_channel_locked。
// - 模板类型后台不能选：SMS_CODE 锁 verify、其余服务类编码锁 notice（契约没写明，以 20001 [template_type]、
//   不落库为准）。
// - 只换签名（模板 CODE 同在用）也是换签名：存为「待测试」、带新签名发测试短信，在用登记不动。
// - DATA_COPY_CODE：只能换模板、不能关、不能开推送；按 D10-341 是普通编码，登记与启用只要 notify.channels。
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  ALERT_ACTIVE,
  CHANNELS,
  LOCKED,
  WD_FAILED_ACTIVE,
  accepted,
  audits,
  itemOf,
  masked,
  ms,
  placeholder,
  previewWith,
  rejected,
  seedTemplate,
  setup,
  smsOf,
  snapshot,
  sorted,
  templateRow,
  variablesOf,
  variantOf,
  type Item,
  type SmsResult,
} from './kit.ts';

const h = useHarness();

/** 一个订阅类编码（P1 订阅提醒；不属于 BR-TEXT-09 表与资金术语键的列表）。 */
const SUBSCRIPTION_CODE = 'WATCH_PRICE_DROP';
const DATA_COPY_PREVIEW =
  '【凑狸】你的个人信息副本提取码为：${code}，${expires_at}前有效，请勿告诉他人。';

it('[AC-B1-12z#55] 订阅类编码（category subscription，推送 + 站内）：列表 sms_switchable false、没有短信登记行、disabled；PATCH 开短信（带不带计费确认）→ 20001 [sms] notify_channel_locked；PUT …/sms（带不带 variant）→ 20001 [code] notify_channel_locked；什么都不写、不发', async () => {
  const s = await setup(h);
  await seedTemplate(s, {
    code: SUBSCRIPTION_CODE,
    category: 'subscription',
    channels: ['push', 'inbox'],
    rowVersion: 2,
  });
  const item = await itemOf(s, SUBSCRIPTION_CODE);
  expect(item).toMatchObject({
    code: SUBSCRIPTION_CODE,
    category: 'subscription',
    sms_switchable: false,
    sms_fixed: false,
    sms_billing_confirm: false,
    sms_ready: false,
    sms_state: 'disabled',
    sms_deploy_fallback: false,
    sms_code_ttl_sec: null,
    sms_registrations: [],
    row_version: 2,
  });
  expect(sorted(item.channels)).toEqual(['inbox', 'push']);

  const before = await snapshot(s);
  for (const body of [
    { sms: true, confirm_sms_billing: true, row_version: 2 },
    { sms: true, row_version: 2 },
  ]) {
    await rejected(await s.switchChannels(SUBSCRIPTION_CODE, body), 'switch', 20001, {
      fields: ['sms'],
      reason: LOCKED,
    });
    expect(await snapshot(s), JSON.stringify(body)).toEqual(before);
  }
  const body = {
    sign_name: '凑狸',
    template_code: 'SMS_550000001',
    template_type: 'notice',
    preview_text: previewWith(['amount']),
    row_version: 2,
  };
  for (const variant of [undefined, 'default', 'no_such_variant']) {
    await rejected(
      await s.register(SUBSCRIPTION_CODE, body, variant === undefined ? {} : { variant }),
      'register',
      20001,
      { fields: ['code'], reason: LOCKED },
    );
    expect(await snapshot(s), String(variant)).toEqual(before);
  }
  expect(smsOf(s.f).outbox()).toEqual([]);
  expect(await itemOf(s, SUBSCRIPTION_CODE)).toEqual(item);
});

it('[AC-B1-12z#56] 模板类型后台不能选：SMS_CODE 以 notice、WD_FAILED 与站长告警以 verify 提交 → 20001 [template_type]，签名与模板 CODE 同在用的就地改也一样；什么都不存、不发', async () => {
  const s = await setup(h);
  await seedTemplate(s, { code: 'SMS_CODE', channels: ['sms'] });
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    rowVersion: 5,
  });
  await seedTemplate(s, {
    code: 'UNION_AUTH_EXPIRING',
    channels: ['sms'],
    active: ALERT_ACTIVE,
    rowVersion: 2,
  });
  const variables = await variablesOf(s, 'WD_FAILED');
  const before = await snapshot(s);
  const typeLocked = expect.objectContaining({ fields: ['template_type'] });
  const cases: [string, Record<string, unknown>][] = [
    [
      'SMS_CODE',
      {
        sign_name: '凑狸',
        template_code: 'SMS_510000003',
        template_type: 'notice',
        preview_text: '【凑狸】你的验证码是${code}，5分钟内有效，请勿泄露。',
        sample: { code: '123456' },
        row_version: 0,
      },
    ],
    [
      'WD_FAILED',
      {
        sign_name: '凑狸',
        template_code: 'SMS_520000003',
        template_type: 'verify',
        preview_text: previewWith(variables),
        row_version: 5,
      },
    ],
    [
      'WD_FAILED',
      {
        sign_name: WD_FAILED_ACTIVE.signName,
        template_code: WD_FAILED_ACTIVE.templateCode,
        template_type: 'verify',
        preview_text: WD_FAILED_ACTIVE.preview,
        row_version: 5,
      },
    ],
    [
      'UNION_AUTH_EXPIRING',
      {
        sign_name: ALERT_ACTIVE.signName,
        template_code: 'SMS_530000002',
        template_type: 'verify',
        preview_text: ALERT_ACTIVE.preview,
        row_version: 2,
      },
    ],
  ];
  for (const [code, body] of cases) {
    await rejected(await s.register(code, body), 'register', 20001, typeLocked);
    expect(await snapshot(s), `${code} ${String(body.template_code)}`).toEqual(before);
  }
  expect(smsOf(s.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#57] 只换签名（模板 CODE 同在用）：存为「待测试」、向操作人验证手机号发测试短信（新签名 + 原模板 CODE）；在用登记与 enabled_at 不变；row_version +1；审计一条', async () => {
  const s = await setup(h);
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    rowVersion: 5,
  });
  const activeBefore = variantOf(await itemOf(s, 'WD_FAILED')).active;
  expect(activeBefore).not.toBeNull();
  const variables = await variablesOf(s, 'WD_FAILED');
  const preview = `【凑狸生活】你的提现结果有更新：${variables.map(placeholder).join('，')}，请在App内查看。`;
  const body = {
    sign_name: '凑狸生活',
    template_code: WD_FAILED_ACTIVE.templateCode,
    template_type: 'notice',
    preview_text: preview,
    sample: { [variables[0]!]: '¥10' },
    row_version: 5,
  };
  const data = await accepted<SmsResult>(await s.register('WD_FAILED', body), 'register');
  const now = s.f.clock.now().getTime();

  expect(data.test_send_phone_masked).toBe(masked(s.phone!));
  expect(data.item.row_version).toBe(6);
  const row = variantOf(data.item);
  expect(row.active).toEqual(activeBefore);
  expect(row.pending).toEqual({
    sign_name: '凑狸生活',
    template_code: WD_FAILED_ACTIVE.templateCode,
    template_type: 'notice',
    preview_text: preview,
    saved_at: expect.any(String),
    test: { status: 'accepted', tested_at: expect.any(String) },
  });
  expect(ms(row.pending!.test.tested_at)).toBe(now);
  expect(await itemOf(s, 'WD_FAILED')).toEqual(data.item);

  const sent = smsOf(s.f).outbox();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    appId: s.appId,
    phone: s.phone,
    signName: '凑狸生活',
    templateCode: WD_FAILED_ACTIVE.templateCode,
  });
  expect(sorted(Object.keys(sent[0]!.params))).toEqual(sorted(variables));
  expect(sent[0]!.params[variables[0]!]).toBe('¥10');

  expect(await templateRow(s, 'WD_FAILED')).toMatchObject({
    sms_sign_name: WD_FAILED_ACTIVE.signName,
    sms_template_code: WD_FAILED_ACTIVE.templateCode,
    sms_template_type: WD_FAILED_ACTIVE.type,
    sms_preview_text: WD_FAILED_ACTIVE.preview,
    sms_pending_sign_name: '凑狸生活',
    sms_pending_template_code: WD_FAILED_ACTIVE.templateCode,
    sms_pending_preview_text: preview,
    sms_test_status: 'accepted',
  });
  expect((await audits(s)).map((r) => r.action)).toEqual([ACTIONS.register]);
});

it('[AC-B1-12z#58] DATA_COPY_CODE（只发短信）：列表只能换模板（sms_fixed）、不能关短信、不能开推送、普通编码（fund_terms false）、变量 code 与 expires_at；PATCH 关短信 / 开推送 → 20001 notify_channel_locked；只持 notify.channels 登记与启用都成功（不是 10403）', async () => {
  const s = await setup(h, { grants: [CHANNELS] });
  await seedTemplate(s, { code: 'DATA_COPY_CODE', channels: ['sms'], rowVersion: 1 });
  const item = await itemOf(s, 'DATA_COPY_CODE');
  expect(item).toEqual({
    code: 'DATA_COPY_CODE',
    category: 'service',
    default_channels: ['sms'],
    channels: ['sms'],
    push_switchable: false,
    sms_switchable: false,
    sms_fixed: true,
    sms_billing_confirm: false,
    fund_terms: false,
    sms_ready: false,
    sms_state: 'enabled_not_ready',
    sms_deploy_fallback: false,
    sms_code_ttl_sec: null,
    sms_registrations: [
      { variant: 'default', variables: expect.any(Array), active: null, pending: null },
    ],
    row_version: 1,
  });
  expect(sorted(variantOf(item).variables)).toEqual(['code', 'expires_at']);

  const before = await snapshot(s);
  for (const [body, field] of [
    [{ sms: false, row_version: 1 }, 'sms'],
    [{ push: true, row_version: 1 }, 'push'],
  ] as const) {
    await rejected(await s.switchChannels('DATA_COPY_CODE', body), 'switch', 20001, {
      fields: [field],
      reason: LOCKED,
    });
    expect(await snapshot(s), JSON.stringify(body)).toEqual(before);
  }

  const saved = await accepted<SmsResult>(
    await s.register('DATA_COPY_CODE', {
      sign_name: '凑狸',
      template_code: 'SMS_560000001',
      template_type: 'notice',
      preview_text: DATA_COPY_PREVIEW,
      sample: { code: '384912' },
      row_version: 1,
    }),
    'register',
  );
  expect(saved.test_send_phone_masked).toBe(masked(s.phone!));
  expect(saved.item).toMatchObject({ row_version: 2, fund_terms: false, sms_ready: false });
  expect(variantOf(saved.item).pending).toMatchObject({
    template_code: 'SMS_560000001',
    template_type: 'notice',
    preview_text: DATA_COPY_PREVIEW,
    test: { status: 'accepted' },
  });
  const sent = smsOf(s.f).outbox();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ phone: s.phone, templateCode: 'SMS_560000001' });
  expect(sorted(Object.keys(sent[0]!.params))).toEqual(['code', 'expires_at']);
  expect(sent[0]!.params.code).toBe('384912');

  const enabled = await accepted<Item>(
    await s.enable('DATA_COPY_CODE', { row_version: 2 }),
    'enable',
  );
  expect(enabled).toMatchObject({ row_version: 3, sms_ready: true, sms_state: 'enabled' });
  expect(variantOf(enabled)).toMatchObject({
    active: { template_code: 'SMS_560000001', preview_text: DATA_COPY_PREVIEW },
    pending: null,
  });
  expect((await audits(s)).map((r) => r.action)).toEqual([ACTIONS.register, ACTIONS.enable]);
});
