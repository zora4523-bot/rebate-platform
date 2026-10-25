// 规则测试（B1-12z；契约 CT-24t adminRegisterNotifySms；08 BR-TEXT-20 细则「短信渠道登记与后台渠道开关」
// 的登记、保存校验与测试发送，BR-ID-45 验证手机号，BR-ID-05 有效期；编排裁定 D10-335 ②③、D10-337 ①、
// D10-339 ③⑤、D10-341、D10-342 ②）：新签名 / 模板 CODE 存为「待测试」、同步向操作人验证手机号发一条
// 测试短信，受理 → accepted、拒绝 → 50301、超时 / 未知 → 50401（都照存 failed，在用登记不动），没有验证
// 手机号 → 照存 not_sent_no_verify_phone、200；签名与模板 CODE 同在用的只就地改正文；资金类编码另要
// content.fund_terms；预览正文的变量、SMS_CODE 有效期、禁用词；20902；审计 notify_sms_register。
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  ARTICLE,
  CHANNELS,
  DENIED,
  FUND,
  LOCKED,
  SEEDED_TESTED_AT,
  STEP_UP,
  WD_FAILED_ACTIVE,
  WD_FAILED_PENDING,
  WD_REJECTED_ACTIVE,
  WD_REJECTED_NEGATIVE_ACTIVE,
  accepted,
  audits,
  itemOf,
  masked,
  ms,
  previewWith,
  rejected,
  seedTemplate,
  serialized,
  setVerifyPhone,
  setup,
  smsOf,
  snapshot,
  sorted,
  templateRow,
  variablesOf,
  variantOf,
  type Registration,
  type Scenario,
  type SmsResult,
  type Where,
} from './kit.ts';

const h = useHarness();

const VERIFY_PREVIEW = '【凑狸】你的验证码是${code}，5分钟内有效，请勿泄露。';

async function seedWdFailed(s: Where, withPending = false) {
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    ...(withPending ? { pending: WD_FAILED_PENDING } : {}),
    rowVersion: 5,
  });
}

/** SMS_CODE：没有在用登记（部署配置兜底），版本 0。 */
async function seedSmsCode(s: Where) {
  await seedTemplate(s, { code: 'SMS_CODE', channels: ['sms'] });
}

function smsCodeBody(patch: Record<string, unknown> = {}) {
  return {
    sign_name: '凑狸',
    template_code: 'SMS_510000003',
    template_type: 'verify',
    preview_text: VERIFY_PREVIEW,
    sample: { code: '123456' },
    row_version: 0,
    ...patch,
  };
}

/** WD_FAILED 的新登记：用列表给出的变量拼预览正文，样例只给第一个变量。 */
async function wdFailedBody(s: Scenario, templateCode = 'SMS_520000003') {
  const variables = await variablesOf(s, 'WD_FAILED');
  return {
    variables,
    body: {
      sign_name: '凑狸',
      template_code: templateCode,
      template_type: 'notice',
      preview_text: previewWith(variables),
      sample: { [variables[0]!]: '¥10' },
      row_version: 5,
    },
  };
}

/** 去掉一个键的请求体副本。 */
function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...body };
  delete copy[key];
  return copy;
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

it('[AC-B1-12z#25] 换模板 CODE、测试受理：存为「待测试」（accepted）、在用登记照旧生效；测试短信发到操作人验证手机号，用新签名与模板 CODE、样例变量；row_version +1；审计一条只带脱敏号', async () => {
  const s = await setup(h);
  await seedWdFailed(s);
  const sms = smsOf(s.f);
  const { variables, body } = await wdFailedBody(s);
  const data = await accepted<SmsResult>(await s.register('WD_FAILED', body), 'register');
  const now = s.f.clock.now().getTime();

  expect(data.test_send_phone_masked).toBe(masked(s.phone!));
  expect(data.item).toMatchObject({ code: 'WD_FAILED', row_version: 6, sms_state: 'enabled' });
  const row = variantOf(data.item);
  expect(row.active).toEqual(activeView(WD_FAILED_ACTIVE));
  expect(row.pending).toEqual({
    sign_name: '凑狸',
    template_code: 'SMS_520000003',
    template_type: 'notice',
    preview_text: body.preview_text,
    saved_at: expect.any(String),
    test: { status: 'accepted', tested_at: expect.any(String) },
  });
  expect(ms(row.pending!.saved_at)).toBe(now);
  expect(ms(row.pending!.test.tested_at)).toBe(now);
  expect(await itemOf(s, 'WD_FAILED')).toEqual(data.item);

  const sent = sms.outbox();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    appId: s.appId,
    phone: s.phone,
    signName: '凑狸',
    templateCode: 'SMS_520000003',
  });
  expect(sorted(Object.keys(sent[0]!.params))).toEqual(sorted(variables));
  expect(sent[0]!.params[variables[0]!]).toBe('¥10');
  for (const name of variables) expect(sent[0]!.params[name], name).toMatch(/\S/);

  expect(await templateRow(s, 'WD_FAILED')).toMatchObject({
    sms_sign_name: WD_FAILED_ACTIVE.signName,
    sms_template_code: WD_FAILED_ACTIVE.templateCode,
    sms_template_type: WD_FAILED_ACTIVE.type,
    sms_preview_text: WD_FAILED_ACTIVE.preview,
    sms_pending_sign_name: '凑狸',
    sms_pending_template_code: 'SMS_520000003',
    sms_pending_template_type: 'notice',
    sms_pending_preview_text: body.preview_text,
    sms_test_status: 'accepted',
  });
  expect(ms((await templateRow(s, 'WD_FAILED')).sms_tested_at)).toBe(now);

  const rows = await audits(s);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ app_id: s.appId, admin_id: s.a.id, action: ACTIONS.register });
  expect(ms(rows[0]!.at)).toBe(now);
  const text = serialized(rows[0]);
  expect(text).toContain('WD_FAILED');
  expect(text).toContain('SMS_520000003');
  expect(text).toContain(masked(s.phone!));
  expect(text).not.toContain(s.phone!);
});

it('[AC-B1-12z#26] 测试被拒（含签名 / 模板 CODE 不对）→ 50301；超时或结果未知 → 50401；两种都照存「待测试」为 failed、row_version +1、在用登记照旧、写审计', async () => {
  for (const [result, code] of [
    ['rejected', 50301],
    ['unknown', 50401],
  ] as const) {
    const s = await setup(h);
    await seedWdFailed(s);
    const sms = smsOf(s.f);
    sms.enqueueResult(result);
    const { body } = await wdFailedBody(s);
    await rejected(await s.register('WD_FAILED', body), 'register', code);
    const now = s.f.clock.now().getTime();
    expect(sms.outbox(), result).toHaveLength(1);
    expect(sms.outbox()[0]).toMatchObject({ phone: s.phone, templateCode: 'SMS_520000003' });

    const item = await itemOf(s, 'WD_FAILED');
    expect(item.row_version, result).toBe(6);
    expect(item.sms_state, result).toBe('enabled');
    const row = variantOf(item);
    expect(row.active, result).toEqual(activeView(WD_FAILED_ACTIVE));
    expect(row.pending, result).toMatchObject({
      template_code: 'SMS_520000003',
      preview_text: body.preview_text,
      test: { status: 'failed' },
    });
    expect(ms(row.pending!.test.tested_at), result).toBe(now);
    expect(await templateRow(s, 'WD_FAILED')).toMatchObject({
      sms_template_code: WD_FAILED_ACTIVE.templateCode,
      sms_pending_template_code: 'SMS_520000003',
      sms_test_status: 'failed',
    });
    const rows = await audits(s);
    expect(
      rows.map((r) => r.action),
      result,
    ).toEqual([ACTIONS.register]);
    expect(serialized(rows[0])).not.toContain(s.phone!);
  }
});

it('[AC-B1-12z#27] 操作人没有验证手机号（含页面加载后才失效）：照存「待测试」为 not_sent_no_verify_phone、不发、200、test_send_phone_masked null，不是 10003', async () => {
  const s = await setup(h, { verifyPhone: false });
  await seedWdFailed(s);
  const sms = smsOf(s.f);
  const { body } = await wdFailedBody(s);
  const data = await accepted<SmsResult>(await s.register('WD_FAILED', body), 'register');
  const now = s.f.clock.now().getTime();
  expect(data.test_send_phone_masked).toBeNull();
  expect(data.item.row_version).toBe(6);
  const pending = variantOf(data.item).pending;
  expect(pending).toMatchObject({
    template_code: 'SMS_520000003',
    test: { status: 'not_sent_no_verify_phone' },
  });
  expect(ms(pending!.test.tested_at)).toBe(now);
  expect(sms.outbox()).toEqual([]);
  expect((await templateRow(s, 'WD_FAILED')).sms_test_status).toBe('not_sent_no_verify_phone');
  expect((await audits(s)).map((r) => r.action)).toEqual([ACTIONS.register]);

  // 有号码的账号在页面加载后号码失效：同样照存、不发。
  const later = await setup(h);
  await seedWdFailed(later);
  const laterBody = (await wdFailedBody(later, 'SMS_520000005')).body;
  await setVerifyPhone(h, later.appId, later.a.id, null);
  const saved = await accepted<SmsResult>(await later.register('WD_FAILED', laterBody), 'register');
  expect(saved.test_send_phone_masked).toBeNull();
  expect(variantOf(saved.item).pending?.test.status).toBe('not_sent_no_verify_phone');
  expect(smsOf(later.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#28] 首次登记（没有在用登记）：SMS_CODE 存为「待测试」，部署配置兜底不变（待测试不顶替）、未就绪；普通编码只要 notify.channels', async () => {
  const s = await setup(h, { grants: [CHANNELS] });
  await seedSmsCode(s);
  const sms = smsOf(s.f);
  const data = await accepted<SmsResult>(await s.register('SMS_CODE', smsCodeBody()), 'register');
  expect(data.test_send_phone_masked).toBe(masked(s.phone!));
  expect(data.item).toMatchObject({
    code: 'SMS_CODE',
    sms_deploy_fallback: true,
    sms_ready: false,
    sms_state: 'enabled',
    row_version: 1,
  });
  const row = variantOf(data.item);
  expect(row.active).toBeNull();
  expect(row.pending).toMatchObject({
    sign_name: '凑狸',
    template_code: 'SMS_510000003',
    template_type: 'verify',
    preview_text: VERIFY_PREVIEW,
    test: { status: 'accepted' },
  });
  expect(sms.outbox()).toEqual([
    {
      appId: s.appId,
      phone: s.phone,
      signName: '凑狸',
      templateCode: 'SMS_510000003',
      params: { code: '123456' },
    },
  ]);
  expect(await templateRow(s, 'SMS_CODE')).toMatchObject({
    sms_sign_name: null,
    sms_template_code: null,
    sms_pending_template_code: 'SMS_510000003',
    sms_test_status: 'accepted',
  });
});

it('[AC-B1-12z#29] 已有「待测试」时再登记新的模板 CODE：替换原「待测试」（重新测试），在用登记不动', async () => {
  const s = await setup(h);
  await seedWdFailed(s, true);
  const { body } = await wdFailedBody(s, 'SMS_520000004');
  const data = await accepted<SmsResult>(await s.register('WD_FAILED', body), 'register');
  const row = variantOf(data.item);
  expect(row.active).toEqual(activeView(WD_FAILED_ACTIVE));
  expect(row.pending).toMatchObject({
    template_code: 'SMS_520000004',
    preview_text: body.preview_text,
    test: { status: 'accepted' },
  });
  expect(
    smsOf(s.f)
      .outbox()
      .map((m) => m.templateCode),
  ).toEqual(['SMS_520000004']);
  expect(data.item.row_version).toBe(6);
});

it('[AC-B1-12z#30] 签名与模板 CODE 同在用登记：只就地改模板类型与正文，不发测试短信（不要验证手机号）、「待测试」原样、test_send_phone_masked null、enabled_at 为此刻、row_version +1、写审计', async () => {
  const s = await setup(h, { verifyPhone: false });
  await seedWdFailed(s, true);
  const variables = await variablesOf(s, 'WD_FAILED');
  const preview = previewWith(variables, '可在App内查看原因。');
  const data = await accepted<SmsResult>(
    await s.register('WD_FAILED', {
      sign_name: WD_FAILED_ACTIVE.signName,
      template_code: WD_FAILED_ACTIVE.templateCode,
      template_type: 'notice',
      preview_text: preview,
      row_version: 5,
    }),
    'register',
  );
  const now = s.f.clock.now().getTime();
  expect(data.test_send_phone_masked).toBeNull();
  expect(data.item.row_version).toBe(6);
  const row = variantOf(data.item);
  expect(row.active).toEqual({
    sign_name: WD_FAILED_ACTIVE.signName,
    template_code: WD_FAILED_ACTIVE.templateCode,
    template_type: 'notice',
    preview_text: preview,
    enabled_at: expect.any(String),
  });
  expect(ms(row.active!.enabled_at)).toBe(now);
  expect(row.pending).toMatchObject({
    template_code: WD_FAILED_PENDING.templateCode,
    preview_text: WD_FAILED_PENDING.preview,
    test: { status: 'failed' },
  });
  expect(ms(row.pending!.test.tested_at)).toBe(SEEDED_TESTED_AT.getTime());
  expect(smsOf(s.f).outbox()).toEqual([]);
  expect(await templateRow(s, 'WD_FAILED')).toMatchObject({
    sms_template_code: WD_FAILED_ACTIVE.templateCode,
    sms_preview_text: preview,
    sms_pending_template_code: WD_FAILED_PENDING.templateCode,
    sms_pending_preview_text: WD_FAILED_PENDING.preview,
    sms_test_status: 'failed',
  });
  expect((await audits(s)).map((r) => r.action)).toEqual([ACTIONS.register]);
});

it('[AC-B1-12z#31] 按 variant 登记：只动该变体的「待测试」，别的变体不动；不给 variant 即 default', async () => {
  const s = await setup(h);
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    channels: ['push', 'inbox'],
    active: WD_REJECTED_ACTIVE,
    rowVersion: 2,
  });
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    variant: 'negative_balance',
    channels: ['push', 'inbox'],
    rowVersion: 2,
  });
  const variables = await variablesOf(s, 'WD_REJECTED', 'negative_balance');
  const data = await accepted<SmsResult>(
    await s.register(
      'WD_REJECTED',
      {
        sign_name: '凑狸',
        template_code: 'SMS_540000005',
        template_type: 'notice',
        preview_text: previewWith(variables),
        row_version: 2,
      },
      { variant: 'negative_balance' },
    ),
    'register',
  );
  expect(variantOf(data.item, 'negative_balance').pending).toMatchObject({
    template_code: 'SMS_540000005',
    test: { status: 'accepted' },
  });
  expect(variantOf(data.item, 'default')).toMatchObject({ pending: null });
  expect(data.item.row_version).toBe(3);
  expect((await templateRow(s, 'WD_REJECTED')).sms_pending_template_code).toBeNull();
  expect(sorted(Object.keys(smsOf(s.f).outbox()[0]!.params))).toEqual(sorted(variables));

  const defaults = await variablesOf(s, 'WD_REJECTED', 'default');
  const second = await accepted<SmsResult>(
    await s.register('WD_REJECTED', {
      sign_name: '凑狸',
      template_code: 'SMS_540000006',
      template_type: 'notice',
      preview_text: previewWith(defaults),
      row_version: 3,
    }),
    'register',
  );
  expect(variantOf(second.item, 'default').pending?.template_code).toBe('SMS_540000006');
  expect(variantOf(second.item, 'negative_balance').pending?.template_code).toBe('SMS_540000005');
});

it('[AC-B1-12z#32] 资金类编码没有 content.fund_terms → 10403，先于可改性、变体与请求体检查；编码检查先于它；有 fund_terms 的资金类只发站内信编码 → 20001 [code] notify_channel_locked', async () => {
  const s = await setup(h, { grants: [CHANNELS] });
  await seedWdFailed(s);
  await seedTemplate(s, { code: 'BALANCE_ADJUSTED', channels: ['inbox'] });
  const { body } = await wdFailedBody(s);
  const before = await snapshot(s);
  await rejected(await s.register('WD_FAILED', body), 'register', 10403, DENIED);
  await rejected(
    await s.register('WD_FAILED', {}, { variant: 'no_such_variant' }),
    'register',
    10403,
    DENIED,
  );
  await rejected(
    await s.register('BALANCE_ADJUSTED', { ...body, row_version: 0 }),
    'register',
    10403,
    DENIED,
  );
  await rejected(await s.register('NO_SUCH_CODE', body), 'register', 20001, { fields: ['code'] });
  expect(await snapshot(s)).toEqual(before);
  expect(smsOf(s.f).outbox()).toEqual([]);

  const full = await setup(h, { grants: [CHANNELS, FUND] });
  await seedTemplate(full, { code: 'BALANCE_ADJUSTED', channels: ['inbox'] });
  await seedTemplate(full, { code: 'RISK_STATE_CHANGED', channels: ['inbox'] });
  for (const code of ['BALANCE_ADJUSTED', 'RISK_STATE_CHANGED']) {
    for (const variant of [undefined, 'no_such_variant']) {
      await rejected(
        await full.register(
          code,
          { ...body, row_version: 0 },
          variant === undefined ? {} : { variant },
        ),
        'register',
        20001,
        { fields: ['code'], reason: LOCKED },
      );
    }
  }
  expect(smsOf(full.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#33] variant 不是该编码的变体 → 20001 [variant]，先于请求体校验', async () => {
  const s = await setup(h);
  await seedSmsCode(s);
  const before = await snapshot(s);
  for (const body of [smsCodeBody(), {}]) {
    await rejected(
      await s.register('SMS_CODE', body, { variant: 'no_such_variant' }),
      'register',
      20001,
      { fields: ['variant'] },
    );
  }
  expect(await snapshot(s)).toEqual(before);
  expect(smsOf(s.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#34] 请求体按契约校验，20001 指明字段；sample 的键不是该变体的变量 → [sample]；什么都不存、不发', async () => {
  const s = await setup(h);
  await seedSmsCode(s);
  const before = await snapshot(s);
  const cases: [Record<string, unknown>, string][] = [
    [without(smsCodeBody(), 'sign_name'), 'sign_name'],
    [smsCodeBody({ sign_name: '' }), 'sign_name'],
    [smsCodeBody({ sign_name: '凑'.repeat(33) }), 'sign_name'],
    [without(smsCodeBody(), 'template_code'), 'template_code'],
    [smsCodeBody({ template_code: 'S'.repeat(65) }), 'template_code'],
    [smsCodeBody({ template_type: 'marketing' }), 'template_type'],
    [smsCodeBody({ preview_text: '' }), 'preview_text'],
    [smsCodeBody({ preview_text: `${VERIFY_PREVIEW}${'字'.repeat(500)}` }), 'preview_text'],
    [without(smsCodeBody(), 'row_version'), 'row_version'],
    [smsCodeBody({ row_version: -1 }), 'row_version'],
    [smsCodeBody({ sample: { code: '123456', nickname: '小明' } }), 'sample'],
    [smsCodeBody({ sample: { amount: '¥10' } }), 'sample'],
  ];
  for (const [body, field] of cases) {
    await rejected(await s.register('SMS_CODE', body), 'register', 20001, { fields: [field] });
    expect(await snapshot(s), JSON.stringify(Object.keys(body))).toEqual(before);
  }
  expect(smsOf(s.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#35] 预览正文的变量须恰好是该变体定义的变量：少、多、写错 → 20001 [preview_text] notify_preview_vars_mismatch', async () => {
  const s = await setup(h);
  await seedSmsCode(s);
  await seedWdFailed(s);
  const variables = await variablesOf(s, 'WD_FAILED');
  const before = await snapshot(s);
  const mismatch = { fields: ['preview_text'], reason: 'notify_preview_vars_mismatch' };
  for (const preview of [
    '【凑狸】你的验证码5分钟内有效，请勿泄露。',
    '【凑狸】你的验证码是${code}，${nickname}请勿泄露。',
    '【凑狸】你的验证码是${verify_code}，请勿泄露。',
  ]) {
    await rejected(
      await s.register('SMS_CODE', smsCodeBody({ preview_text: preview })),
      'register',
      20001,
      mismatch,
    );
  }
  for (const preview of [
    previewWith(variables.slice(1)),
    previewWith([...variables, 'nickname']),
  ]) {
    await rejected(
      await s.register('WD_FAILED', { ...(await wdFailedBody(s)).body, preview_text: preview }),
      'register',
      20001,
      mismatch,
    );
  }
  expect(await snapshot(s)).toEqual(before);
  expect(smsOf(s.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#36] SMS_CODE 正文写的有效分钟数须等于 BR-ID-05 的有效期（300 秒）：10 分钟、1 分钟 → notify_code_ttl_mismatch；不写有效期可以保存；别的编码不查分钟数', async () => {
  const s = await setup(h);
  await seedSmsCode(s);
  await seedWdFailed(s);
  const before = await snapshot(s);
  for (const preview of [
    '【凑狸】你的验证码是${code}，10分钟内有效，请勿泄露。',
    '【凑狸】你的验证码是${code}，1分钟内有效，请勿泄露。',
  ]) {
    await rejected(
      await s.register('SMS_CODE', smsCodeBody({ preview_text: preview })),
      'register',
      20001,
      { fields: ['preview_text'], reason: 'notify_code_ttl_mismatch' },
    );
  }
  expect(await snapshot(s)).toEqual(before);
  const noTtl = '【凑狸】你的验证码是${code}，请勿泄露。';
  const saved = await accepted<SmsResult>(
    await s.register('SMS_CODE', smsCodeBody({ preview_text: noTtl })),
    'register',
  );
  expect(variantOf(saved.item).pending?.preview_text).toBe(noTtl);

  const variables = await variablesOf(s, 'WD_FAILED');
  const other = await accepted<SmsResult>(
    await s.register('WD_FAILED', {
      ...(await wdFailedBody(s)).body,
      preview_text: previewWith(variables, '10分钟后可在App内查看。'),
    }),
    'register',
  );
  expect(variantOf(other.item).pending?.test.status).toBe('accepted');
});

it('[AC-B1-12z#37] 预览正文过 BR-TEXT-13 / BR-TEXT-20：含「官方」或禁用词 → 20001，fields 为 preview_text 后接命中的词；签名后首句以平台名开头 → 20001 [preview_text, …]', async () => {
  const s = await setup(h);
  await seedSmsCode(s);
  const before = await snapshot(s);
  for (const [preview, words] of [
    ['【凑狸】官方提醒：你的验证码是${code}，请勿泄露。', ['官方']],
    ['【凑狸】你的验证码是${code}，稳赚不赔。', ['稳赚']],
  ] as const) {
    await rejected(
      await s.register('SMS_CODE', smsCodeBody({ preview_text: preview })),
      'register',
      20001,
      { fields: ['preview_text', ...words] },
    );
  }
  const leading = await s.register(
    'SMS_CODE',
    smsCodeBody({ preview_text: '【凑狸】淘宝提醒你：验证码是${code}，请勿泄露。' }),
  );
  await rejected(
    leading,
    'register',
    20001,
    expect.objectContaining({ fields: expect.arrayContaining(['preview_text']) }),
  );
  expect(leading.json<{ data?: { fields?: string[] } }>().data?.fields?.[0]).toBe('preview_text');
  expect(await snapshot(s)).toEqual(before);
  expect(smsOf(s.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#38] 检查顺序：变量不一致先于有效期，有效期先于禁用词，正文检查都先于 20902', async () => {
  const s = await setup(h);
  await seedSmsCode(s);
  const before = await snapshot(s);
  await rejected(
    await s.register(
      'SMS_CODE',
      smsCodeBody({ preview_text: '【凑狸】你的验证码10分钟内有效。', row_version: 9 }),
    ),
    'register',
    20001,
    { fields: ['preview_text'], reason: 'notify_preview_vars_mismatch' },
  );
  await rejected(
    await s.register(
      'SMS_CODE',
      smsCodeBody({ preview_text: '【凑狸】官方验证码${code}，10分钟内有效。', row_version: 9 }),
    ),
    'register',
    20001,
    { fields: ['preview_text'], reason: 'notify_code_ttl_mismatch' },
  );
  await rejected(
    await s.register(
      'SMS_CODE',
      smsCodeBody({ preview_text: '【凑狸】官方提醒：你的验证码是${code}。', row_version: 9 }),
    ),
    'register',
    20001,
    { fields: ['preview_text', '官方'] },
  );
  expect(await snapshot(s)).toEqual(before);
  expect(smsOf(s.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#39] row_version 与当前不符 → 20902、不带 data；什么都不存，也不发测试短信', async () => {
  const s = await setup(h);
  await seedWdFailed(s);
  const { body } = await wdFailedBody(s);
  const before = await snapshot(s);
  for (const rowVersion of [4, 6]) {
    await rejected(
      await s.register('WD_FAILED', { ...body, row_version: rowVersion }),
      'register',
      20902,
    );
  }
  expect(await snapshot(s)).toEqual(before);
  expect(smsOf(s.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#40] 每次都要 totp 动态码（保存与测试发送共用一枚）：缺失 → 10003，权限先于动态码；成功后同一令牌重放 → 10003；一次保存只发一条', async () => {
  const s = await setup(h);
  await seedSmsCode(s);
  const before = await snapshot(s);
  await rejected(
    await s.register('SMS_CODE', smsCodeBody(), { token: null }),
    'register',
    10003,
    STEP_UP,
  );
  await rejected(await s.register('NO_SUCH_CODE', {}, { token: null }), 'register', 10003, STEP_UP);
  expect(await snapshot(s)).toEqual(before);

  const token = await s.issue();
  await accepted(await s.register('SMS_CODE', smsCodeBody(), { token }), 'register');
  expect(smsOf(s.f).outbox()).toHaveLength(1);
  await rejected(
    await s.register('SMS_CODE', smsCodeBody({ row_version: 1 }), { token }),
    'register',
    10003,
    STEP_UP,
  );
  expect(smsOf(s.f).outbox()).toHaveLength(1);

  const reader = await setup(h, { grants: [ARTICLE] });
  await seedSmsCode(reader);
  await rejected(
    await reader.register('SMS_CODE', smsCodeBody(), { token: null }),
    'register',
    10403,
    DENIED,
  );
  await rejected(await reader.register('SMS_CODE', smsCodeBody()), 'register', 10403, DENIED);
  expect(smsOf(reader.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#41] 没有幂等键：同样的保存再来一次就是新的一次调用，再发一条测试短信、row_version 再 +1', async () => {
  const s = await setup(h);
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    channels: ['push', 'inbox'],
    active: WD_REJECTED_ACTIVE,
    rowVersion: 1,
  });
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    variant: 'negative_balance',
    channels: ['push', 'inbox'],
    active: WD_REJECTED_NEGATIVE_ACTIVE,
    rowVersion: 1,
  });
  const variables = await variablesOf(s, 'WD_REJECTED');
  const body = {
    sign_name: '凑狸',
    template_code: 'SMS_540000007',
    template_type: 'notice',
    preview_text: previewWith(variables),
  };
  const first = await accepted<SmsResult>(
    await s.register('WD_REJECTED', { ...body, row_version: 1 }),
    'register',
  );
  const second = await accepted<SmsResult>(
    await s.register('WD_REJECTED', { ...body, row_version: 2 }),
    'register',
  );
  expect([first.item.row_version, second.item.row_version]).toEqual([2, 3]);
  expect(
    smsOf(s.f)
      .outbox()
      .map((m) => m.templateCode),
  ).toEqual(['SMS_540000007', 'SMS_540000007']);
  expect((await audits(s)).map((r) => r.action)).toEqual([ACTIONS.register, ACTIONS.register]);
  expect(variantOf(second.item).pending).toMatchObject({ ...body, test: { status: 'accepted' } });
});
