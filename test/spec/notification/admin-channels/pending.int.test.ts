// 规则测试（B1-12z；契约 CT-24t adminRetestNotifySms / adminEnableNotifySms / adminDiscardNotifySms；
// 08 BR-TEXT-20 细则「短信渠道登记与后台渠道开关」的「待测试」登记、启用与放弃，BR-ID-45；编排裁定
// D10-335 ③④、D10-337 ①②、D10-339 ①②③⑤⑥、D10-342 ②）：
// - 重新测试：notify.channels + totp、不要 content.fund_terms；结果替换「待测试」的 test（accepted / 50301 /
//   50401 存 failed），没有验证手机号 → 10003 verify_phone_missing（只此一处）；审计 notify_sms_test。
// - 启用：notify.channels + totp，资金类另要 content.fund_terms；只有测试已受理的「待测试」能启用，启用者
//   不必有验证手机号、不发短信；在用登记被替换、「待测试」清空；就绪后 enabled_not_ready → enabled，关着的
//   仍关；SMS_CODE 不再走部署配置；审计 notify_sms_enable。
// - 放弃：只要 notify.channels（不要动态码与 fund_terms），只丢「待测试」；没有「待测试」照常成功、版本不变；
//   row_version 缺失或不合法 20001、不符 20902；审计 notify_sms_discard。
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  ARTICLE,
  CHANNELS,
  DENIED,
  SEEDED_TESTED_AT,
  SMS_CODE_ACTIVE,
  SMS_CODE_PENDING,
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
  pendingOf,
  rejected,
  seedTemplate,
  serialized,
  setVerifyPhone,
  setup,
  signIn,
  smsOf,
  snapshot,
  sorted,
  templateRow,
  variablesOf,
  variantOf,
  type Item,
  type PendingRegistration,
  type Registration,
  type SmsResult,
  type Where,
} from './kit.ts';

const h = useHarness();

const WD_REJECTED_PENDING = pendingOf(WD_REJECTED_ACTIVE, 'failed', 'SMS_540000013');
const WD_NEGATIVE_PENDING = pendingOf(WD_REJECTED_NEGATIVE_ACTIVE, 'accepted', 'SMS_540000014');

/** WD_REJECTED：推送 + 站内；两个变体都没有在用登记，各有一条「待测试」，版本 4。 */
async function seedWdRejected(
  s: Where,
  pending: { readonly default?: PendingRegistration; readonly negative?: PendingRegistration } = {
    default: WD_REJECTED_PENDING,
    negative: WD_NEGATIVE_PENDING,
  },
  channels: readonly ('inbox' | 'push' | 'sms')[] = ['push', 'inbox'],
) {
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    channels,
    ...(pending.default === undefined ? {} : { pending: pending.default }),
    rowVersion: 4,
  });
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    variant: 'negative_balance',
    channels,
    ...(pending.negative === undefined ? {} : { pending: pending.negative }),
    rowVersion: 4,
  });
}

function pendingView(registration: PendingRegistration, status = registration.status) {
  return {
    sign_name: registration.signName,
    template_code: registration.templateCode,
    template_type: registration.type,
    preview_text: registration.preview,
    saved_at: expect.any(String),
    test: { status, tested_at: expect.any(String) },
  };
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

// —— 重新测试 ——

it('[AC-B1-12z#42] 重新测试：向操作人验证手机号发一条（「待测试」的签名与模板 CODE、样例变量），受理 → test 换成 accepted、tested_at 为此刻，其余不动；row_version +1；资金类编码不要 content.fund_terms；审计一条只带脱敏号', async () => {
  const s = await setup(h, { grants: [CHANNELS] });
  await seedWdRejected(s);
  const sms = smsOf(s.f);
  const variables = await variablesOf(s, 'WD_REJECTED');
  const data = await accepted<SmsResult>(
    await s.retest('WD_REJECTED', {
      sample: { [variables[0]!]: '收款账号信息有误' },
      row_version: 4,
    }),
    'retest',
  );
  const now = s.f.clock.now().getTime();
  expect(data.test_send_phone_masked).toBe(masked(s.phone!));
  expect(data.item.row_version).toBe(5);
  const row = variantOf(data.item);
  expect(row.active).toBeNull();
  expect(row.pending).toEqual(pendingView(WD_REJECTED_PENDING, 'accepted'));
  expect(ms(row.pending!.test.tested_at)).toBe(now);
  expect(variantOf(data.item, 'negative_balance').pending).toEqual(
    pendingView(WD_NEGATIVE_PENDING),
  );
  expect(await itemOf(s, 'WD_REJECTED')).toEqual(data.item);

  const sent = sms.outbox();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    appId: s.appId,
    phone: s.phone,
    signName: WD_REJECTED_PENDING.signName,
    templateCode: WD_REJECTED_PENDING.templateCode,
  });
  expect(sorted(Object.keys(sent[0]!.params))).toEqual(sorted(variables));
  expect(sent[0]!.params[variables[0]!]).toBe('收款账号信息有误');

  expect(await templateRow(s, 'WD_REJECTED')).toMatchObject({
    sms_sign_name: null,
    sms_pending_template_code: WD_REJECTED_PENDING.templateCode,
    sms_test_status: 'accepted',
  });
  const rows = await audits(s);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ app_id: s.appId, admin_id: s.a.id, action: ACTIONS.test });
  expect(ms(rows[0]!.at)).toBe(now);
  const text = serialized(rows[0]);
  expect(text).toContain('WD_REJECTED');
  expect(text).toContain(masked(s.phone!));
  expect(text).not.toContain(s.phone!);
});

it('[AC-B1-12z#43] 重新测试被拒 → 50301、超时或未知 → 50401：test 存为 failed、row_version +1、在用登记照旧；不管原来的测试结果（已受理的也能重测）', async () => {
  for (const [result, code] of [
    ['rejected', 50301],
    ['unknown', 50401],
  ] as const) {
    const s = await setup(h);
    await seedTemplate(s, {
      code: 'WD_FAILED',
      channels: ['push', 'inbox', 'sms'],
      active: WD_FAILED_ACTIVE,
      pending: pendingOf(WD_FAILED_PENDING, 'accepted'),
      rowVersion: 5,
    });
    const sms = smsOf(s.f);
    sms.enqueueResult(result);
    await rejected(await s.retest('WD_FAILED', { row_version: 5 }), 'retest', code);
    const now = s.f.clock.now().getTime();
    expect(
      sms.outbox().map((m) => m.templateCode),
      result,
    ).toEqual([WD_FAILED_PENDING.templateCode]);
    const item = await itemOf(s, 'WD_FAILED');
    expect(item).toMatchObject({ row_version: 6, sms_state: 'enabled', sms_ready: true });
    const row = variantOf(item);
    expect(row.active, result).toEqual(activeView(WD_FAILED_ACTIVE));
    expect(row.pending, result).toEqual(pendingView(WD_FAILED_PENDING, 'failed'));
    expect(ms(row.pending!.test.tested_at), result).toBe(now);
    expect((await templateRow(s, 'WD_FAILED')).sms_test_status, result).toBe('failed');
    expect(
      (await audits(s)).map((r) => r.action),
      result,
    ).toEqual([ACTIONS.test]);
  }
});

it('[AC-B1-12z#44] 重新测试时没有验证手机号 → 10003 {tier: totp, reason: verify_phone_missing}，不发不存；登记号码后同一操作成功', async () => {
  const s = await setup(h, { verifyPhone: false });
  await seedWdRejected(s);
  const before = await snapshot(s);
  await rejected(await s.retest('WD_REJECTED', { row_version: 4 }), 'retest', 10003, {
    tier: 'totp',
    reason: 'verify_phone_missing',
  });
  expect(await snapshot(s)).toEqual(before);
  expect(smsOf(s.f).outbox()).toEqual([]);

  const phone = '13912345678';
  await setVerifyPhone(h, s.appId, s.a.id, phone);
  const data = await accepted<SmsResult>(
    await s.retest('WD_REJECTED', { row_version: 4 }),
    'retest',
  );
  expect(data.test_send_phone_masked).toBe(masked(phone));
  expect(
    smsOf(s.f)
      .outbox()
      .map((m) => m.phone),
  ).toEqual([phone]);
});

it('[AC-B1-12z#45] 重新测试的检查顺序：编码 → 变体 → 请求体（sample 键不是变量 → [sample]）→ 没有「待测试」→ [variant] → 20902 → 没有验证手机号', async () => {
  const s = await setup(h, { verifyPhone: false });
  await seedWdRejected(s, { negative: WD_NEGATIVE_PENDING });
  const before = await snapshot(s);
  const cases: [Parameters<typeof s.retest>, number, object | undefined][] = [
    [['NO_SUCH_CODE', {}], 20001, { fields: ['code'] }],
    [['WD_REJECTED', {}, { variant: 'no_such_variant' }], 20001, { fields: ['variant'] }],
    [
      ['WD_REJECTED', { sample: { nickname: '小明' }, row_version: 4 }],
      20001,
      { fields: ['sample'] },
    ],
    [['WD_REJECTED', {}], 20001, { fields: ['row_version'] }],
    // default 没有「待测试」：先于 20902 与验证手机号。
    [['WD_REJECTED', { row_version: 9 }], 20001, { fields: ['variant'] }],
    // negative_balance 有「待测试」：20902 先于验证手机号。
    [['WD_REJECTED', { row_version: 9 }, { variant: 'negative_balance' }], 20902, undefined],
    [
      ['WD_REJECTED', { row_version: 4 }, { variant: 'negative_balance' }],
      10003,
      { tier: 'totp', reason: 'verify_phone_missing' },
    ],
  ];
  for (const [args, code, data] of cases) {
    await rejected(await s.retest(...args), 'retest', code, data);
    expect(await snapshot(s), JSON.stringify(args)).toEqual(before);
  }
  expect(smsOf(s.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#46] 重新测试每次都要 totp 动态码（缺失 → 10003 {tier: totp}，不是 verify_phone_missing）；只有 content.article → 10403', async () => {
  const s = await setup(h);
  await seedWdRejected(s);
  const before = await snapshot(s);
  await rejected(
    await s.retest('WD_REJECTED', { row_version: 4 }, { token: null }),
    'retest',
    10003,
    STEP_UP,
  );
  await rejected(
    await s.retest('WD_REJECTED', { row_version: 4 }, { token: 'invalid-step-up-token' }),
    'retest',
    10003,
    STEP_UP,
  );
  expect(await snapshot(s)).toEqual(before);
  const reader = await setup(h, { grants: [ARTICLE] });
  await seedWdRejected(reader);
  await rejected(await reader.retest('WD_REJECTED', { row_version: 4 }), 'retest', 10403, DENIED);
  expect(smsOf(s.f).outbox()).toEqual([]);
  expect(smsOf(reader.f).outbox()).toEqual([]);
});

// —— 启用 ——

it('[AC-B1-12z#47] 启用测试已受理的「待测试」：成为在用登记（enabled_at 为此刻）、「待测试」清空、row_version +1；启用者没有验证手机号也行、不发短信；全部变体启用后才就绪，关着的短信仍关；审计 notify_sms_enable', async () => {
  const s = await setup(h, { verifyPhone: false });
  await seedWdRejected(s, {
    default: pendingOf(WD_REJECTED_PENDING, 'accepted'),
    negative: WD_NEGATIVE_PENDING,
  });
  const first = await accepted<Item>(await s.enable('WD_REJECTED', { row_version: 4 }), 'enable');
  const now = s.f.clock.now().getTime();
  expect(first).toMatchObject({ row_version: 5, sms_ready: false, sms_state: 'disabled' });
  const row = variantOf(first);
  expect(row.active).toEqual(activeView(WD_REJECTED_PENDING));
  expect(ms(row.active!.enabled_at)).toBe(now);
  expect(row.pending).toBeNull();
  expect(variantOf(first, 'negative_balance').pending).toEqual(pendingView(WD_NEGATIVE_PENDING));
  expect(await templateRow(s, 'WD_REJECTED')).toMatchObject({
    sms_sign_name: WD_REJECTED_PENDING.signName,
    sms_template_code: WD_REJECTED_PENDING.templateCode,
    sms_template_type: WD_REJECTED_PENDING.type,
    sms_preview_text: WD_REJECTED_PENDING.preview,
    sms_pending_sign_name: null,
    sms_pending_template_code: null,
    sms_pending_template_type: null,
    sms_pending_preview_text: null,
    sms_test_status: null,
    sms_tested_at: null,
  });

  const second = await accepted<Item>(
    await s.enable('WD_REJECTED', { row_version: 5 }, { variant: 'negative_balance' }),
    'enable',
  );
  expect(second).toMatchObject({ row_version: 6, sms_ready: true, sms_state: 'disabled' });
  expect(sorted(second.channels)).toEqual(['inbox', 'push']);
  expect(variantOf(second, 'negative_balance').active).toEqual(activeView(WD_NEGATIVE_PENDING));
  expect(await itemOf(s, 'WD_REJECTED')).toEqual(second);
  expect(smsOf(s.f).outbox()).toEqual([]);

  const rows = await audits(s);
  expect(rows.map((r) => r.action)).toEqual([ACTIONS.enable, ACTIONS.enable]);
  expect(rows[0]).toMatchObject({ app_id: s.appId, admin_id: s.a.id });
  expect(serialized(rows[1])).toContain('negative_balance');
  expect(serialized(rows)).toContain(WD_NEGATIVE_PENDING.templateCode);
});

it('[AC-B1-12z#48] 启用使默认含短信的编码就绪：enabled_not_ready → enabled；替换原在用登记；SMS_CODE 启用后不再走部署配置兜底', async () => {
  const s = await setup(h);
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    pending: pendingOf(WD_FAILED_PENDING, 'accepted'),
    rowVersion: 2,
  });
  await seedTemplate(s, {
    code: 'SMS_CODE',
    channels: ['sms'],
    pending: SMS_CODE_PENDING,
    rowVersion: 1,
  });
  expect((await itemOf(s, 'WD_FAILED')).sms_state).toBe('enabled_not_ready');
  const wd = await accepted<Item>(await s.enable('WD_FAILED', { row_version: 2 }), 'enable');
  expect(wd).toMatchObject({ sms_ready: true, sms_state: 'enabled', row_version: 3 });

  const smsCode = await accepted<Item>(await s.enable('SMS_CODE', { row_version: 1 }), 'enable');
  expect(smsCode).toMatchObject({
    sms_ready: true,
    sms_state: 'enabled',
    sms_deploy_fallback: false,
    row_version: 2,
  });
  expect(variantOf(smsCode).active).toEqual(activeView(SMS_CODE_PENDING));

  const replace = await setup(h);
  await seedTemplate(replace, {
    code: 'SMS_CODE',
    channels: ['sms'],
    active: SMS_CODE_ACTIVE,
    pending: SMS_CODE_PENDING,
    rowVersion: 6,
  });
  const replaced = await accepted<Item>(
    await replace.enable('SMS_CODE', { row_version: 6 }),
    'enable',
  );
  expect(variantOf(replaced)).toMatchObject({
    active: activeView(SMS_CODE_PENDING),
    pending: null,
  });
  expect((await templateRow(replace, 'SMS_CODE')).sms_template_code).toBe(
    SMS_CODE_PENDING.templateCode,
  );
});

it('[AC-B1-12z#49] 只有测试已受理的才能启用：测试失败、未发送（没有验证手机号）或没有「待测试」→ 20001 [variant]，什么都不改', async () => {
  const s = await setup(h);
  await seedWdRejected(s, {
    default: pendingOf(WD_REJECTED_PENDING, 'failed'),
    negative: pendingOf(WD_NEGATIVE_PENDING, 'not_sent_no_verify_phone'),
  });
  await seedTemplate(s, { code: 'SMS_CODE', channels: ['sms'], rowVersion: 1 });
  const before = await snapshot(s);
  await rejected(await s.enable('WD_REJECTED', { row_version: 4 }), 'enable', 20001, {
    fields: ['variant'],
  });
  await rejected(
    await s.enable('WD_REJECTED', { row_version: 4 }, { variant: 'negative_balance' }),
    'enable',
    20001,
    { fields: ['variant'] },
  );
  await rejected(await s.enable('SMS_CODE', { row_version: 1 }), 'enable', 20001, {
    fields: ['variant'],
  });
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-12z#50] 启用资金类编码另要 content.fund_terms（缺 → 10403，先于变体、请求体与「待测试」检查）；普通编码只要 notify.channels', async () => {
  const s = await setup(h, { grants: [CHANNELS] });
  await seedWdRejected(s, { default: pendingOf(WD_REJECTED_PENDING, 'accepted') });
  await seedTemplate(s, {
    code: 'SMS_CODE',
    channels: ['sms'],
    pending: SMS_CODE_PENDING,
    rowVersion: 1,
  });
  const before = await snapshot(s);
  for (const [body, variant] of [
    [{ row_version: 4 }, undefined],
    [{}, 'no_such_variant'],
    [{ row_version: 4 }, 'negative_balance'],
  ] as const) {
    await rejected(
      await s.enable('WD_REJECTED', body, variant === undefined ? {} : { variant }),
      'enable',
      10403,
      DENIED,
    );
  }
  expect(await snapshot(s)).toEqual(before);
  const smsCode = await accepted<Item>(await s.enable('SMS_CODE', { row_version: 1 }), 'enable');
  expect(variantOf(smsCode).active).toEqual(activeView(SMS_CODE_PENDING));
});

it('[AC-B1-12z#51] 启用的检查顺序：动态码 → 编码 → 变体 → 请求体 → 「待测试」→ 20902；不符 20902 不带 data', async () => {
  const s = await setup(h);
  await seedWdRejected(s, { default: pendingOf(WD_REJECTED_PENDING, 'accepted') });
  const before = await snapshot(s);
  await rejected(await s.enable('NO_SUCH_CODE', {}, { token: null }), 'enable', 10003, STEP_UP);
  await rejected(await s.enable('NO_SUCH_CODE', {}), 'enable', 20001, { fields: ['code'] });
  await rejected(
    await s.enable('WD_REJECTED', {}, { variant: 'no_such_variant' }),
    'enable',
    20001,
    { fields: ['variant'] },
  );
  await rejected(await s.enable('WD_REJECTED', {}), 'enable', 20001, { fields: ['row_version'] });
  await rejected(
    await s.enable('WD_REJECTED', { row_version: 9 }, { variant: 'negative_balance' }),
    'enable',
    20001,
    { fields: ['variant'] },
  );
  for (const rowVersion of [3, 5]) {
    await rejected(await s.enable('WD_REJECTED', { row_version: rowVersion }), 'enable', 20902);
  }
  expect(await snapshot(s)).toEqual(before);
  const reader = await signIn(h, s.f, s.appId, { grants: [ARTICLE] });
  await rejected(await reader.enable('WD_REJECTED', { row_version: 4 }), 'enable', 10403, DENIED);
  expect(await snapshot(s)).toEqual(before);
});

// —— 放弃 ——

it('[AC-B1-12z#52] 放弃新配置：只要 notify.channels（不带动态码、资金类也不要 fund_terms），只丢「待测试」，在用登记与渠道不动，row_version +1，审计 notify_sms_discard', async () => {
  const s = await setup(h, { grants: [CHANNELS] });
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    pending: WD_FAILED_PENDING,
    rowVersion: 5,
  });
  const data = await accepted<Item>(
    await s.discard('WD_FAILED', { variant: 'default', row_version: 5 }),
    'discard',
  );
  const now = s.f.clock.now().getTime();
  expect(data).toMatchObject({ row_version: 6, sms_state: 'enabled', sms_ready: true });
  expect(sorted(data.channels)).toEqual(['inbox', 'push', 'sms']);
  expect(variantOf(data)).toEqual({
    variant: 'default',
    variables: expect.any(Array),
    active: activeView(WD_FAILED_ACTIVE),
    pending: null,
  });
  expect(await itemOf(s, 'WD_FAILED')).toEqual(data);
  expect(await templateRow(s, 'WD_FAILED')).toMatchObject({
    sms_template_code: WD_FAILED_ACTIVE.templateCode,
    sms_preview_text: WD_FAILED_ACTIVE.preview,
    sms_pending_sign_name: null,
    sms_pending_template_code: null,
    sms_pending_template_type: null,
    sms_pending_preview_text: null,
    sms_test_status: null,
    sms_tested_at: null,
  });
  const rows = await audits(s);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ app_id: s.appId, admin_id: s.a.id, action: ACTIONS.discard });
  expect(ms(rows[0]!.at)).toBe(now);
  expect(serialized(rows[0])).toContain(WD_FAILED_PENDING.templateCode);
  expect(smsOf(s.f).outbox()).toEqual([]);
});

it('[AC-B1-12z#53] 放弃：不给 variant 即 default、别的变体不动；没有「待测试」→ 成功、什么都不改、row_version 不变；测试已受理的也能放弃', async () => {
  const s = await setup(h);
  await seedWdRejected(s, {
    default: pendingOf(WD_REJECTED_PENDING, 'accepted'),
    negative: WD_NEGATIVE_PENDING,
  });
  const data = await accepted<Item>(await s.discard('WD_REJECTED', { row_version: 4 }), 'discard');
  expect(data.row_version).toBe(5);
  expect(variantOf(data).pending).toBeNull();
  expect(variantOf(data, 'negative_balance').pending).toEqual(pendingView(WD_NEGATIVE_PENDING));
  expect(ms(variantOf(data, 'negative_balance').pending!.test.tested_at)).toBe(
    SEEDED_TESTED_AT.getTime(),
  );

  const rows = await s.h.db
    .selectFrom('notify_templates')
    .select(['variant', 'row_version', 'sms_pending_template_code'])
    .where('app_id', '=', s.appId)
    .orderBy('variant')
    .execute();
  expect(rows.map((row) => [row.variant, row.sms_pending_template_code])).toEqual([
    ['default', null],
    ['negative_balance', WD_NEGATIVE_PENDING.templateCode],
  ]);

  const before = await snapshot(s);
  const again = await accepted<Item>(await s.discard('WD_REJECTED', { row_version: 5 }), 'discard');
  expect(again.row_version).toBe(5);
  expect(again).toEqual(data);
  expect((await snapshot(s)).rows).toEqual(before.rows);
});

it('[AC-B1-12z#54] 放弃的检查顺序：权限 → 编码 → 变体 → row_version 缺失或不合法 → 20001 [row_version] → 不符 → 20902（不带 data）', async () => {
  const s = await setup(h);
  await seedWdRejected(s);
  const before = await snapshot(s);
  const cases: [string, Record<string, string | number | undefined>, number, object | undefined][] =
    [
      ['NO_SUCH_CODE', { row_version: 4 }, 20001, { fields: ['code'] }],
      ['NO_SUCH_CODE', {}, 20001, { fields: ['code'] }],
      [
        'WD_REJECTED',
        { variant: 'no_such_variant', row_version: 4 },
        20001,
        { fields: ['variant'] },
      ],
      ['WD_REJECTED', { variant: 'no_such_variant' }, 20001, { fields: ['variant'] }],
      ['WD_REJECTED', {}, 20001, { fields: ['row_version'] }],
      ['WD_REJECTED', { row_version: 'four' }, 20001, { fields: ['row_version'] }],
      ['WD_REJECTED', { row_version: -1 }, 20001, { fields: ['row_version'] }],
      ['WD_REJECTED', { row_version: 3 }, 20902, undefined],
      ['WD_REJECTED', { row_version: 5 }, 20902, undefined],
      ['WD_REJECTED', { variant: 'negative_balance', row_version: 0 }, 20902, undefined],
    ];
  for (const [code, values, errorCode, data] of cases) {
    await rejected(await s.discard(code, values), 'discard', errorCode, data);
    expect(await snapshot(s), `${code} ${JSON.stringify(values)}`).toEqual(before);
  }
  const reader = await signIn(h, s.f, s.appId, { grants: [ARTICLE, 'content.fund_terms'] });
  await rejected(await reader.discard('WD_REJECTED', { row_version: 4 }), 'discard', 10403, DENIED);
  await rejected(await reader.discard('NO_SUCH_CODE', {}), 'discard', 10403, DENIED);
  expect(await snapshot(s)).toEqual(before);
});
