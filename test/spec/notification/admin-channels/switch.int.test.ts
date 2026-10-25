// 规则测试（B1-12z；契约 CT-24t adminSwitchNotifyChannels；08 BR-TEXT-20 细则「短信渠道登记与后台渠道
// 开关」；编排裁定 D10-335 ②、D10-337 ②④、D10-339 ⑥）：开关推送 / 短信要 notify.channels + 每次 totp
// 动态码、不要 content.fund_terms；站内信不能增删；不能开关的渠道 notify_channel_locked；未就绪不能开短信；
// 默认不含短信的服务类编码开短信要 confirm_sms_billing；row_version 不符 20902（无 data）；没有变化不写；
// 每次改动写一条审计 notify_channel_switch；检查顺序以契约为准。
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  ALERT_ACTIVE,
  ARTICLE,
  CHANNELS,
  DENIED,
  LOCKED,
  SMS_CODE_ACTIVE,
  STEP_UP,
  WD_FAILED_ACTIVE,
  WD_REJECTED_ACTIVE,
  WD_REJECTED_NEGATIVE_ACTIVE,
  accepted,
  audits,
  itemOf,
  ms,
  rejected,
  seedTemplate,
  serialized,
  setup,
  signIn,
  snapshot,
  sorted,
  templateRow,
  type Item,
  type Where,
} from './kit.ts';

const h = useHarness();

/** WD_FAILED：推送 + 站内 + 短信、在用登记、版本 5。 */
async function seedWdFailed(s: Where, rowVersion = 5) {
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    rowVersion,
  });
}

/** WD_REJECTED：推送 + 站内；两个变体都已启用登记（就绪），版本 3。 */
async function seedWdRejectedReady(s: Where, rowVersion = 3) {
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    channels: ['push', 'inbox'],
    active: WD_REJECTED_ACTIVE,
    rowVersion,
  });
  await seedTemplate(s, {
    code: 'WD_REJECTED',
    variant: 'negative_balance',
    channels: ['push', 'inbox'],
    active: WD_REJECTED_NEGATIVE_ACTIVE,
    rowVersion,
  });
}

it('[AC-B1-12z#13] 关推送：只要 notify.channels（资金类编码也不要 content.fund_terms），站内信与短信不动，row_version +1，响应即 GET 的这一项，写一条审计', async () => {
  const s = await setup(h, { grants: [CHANNELS] });
  await seedWdFailed(s);
  const data = await accepted<Item>(
    await s.switchChannels('WD_FAILED', { push: false, row_version: 5 }),
    'switch',
  );
  const now = s.f.clock.now().getTime();
  expect(sorted(data.channels)).toEqual(['inbox', 'sms']);
  expect(data).toMatchObject({
    code: 'WD_FAILED',
    row_version: 6,
    sms_state: 'enabled',
    fund_terms: true,
  });
  expect(await itemOf(s, 'WD_FAILED')).toEqual(data);
  expect(sorted((await templateRow(s, 'WD_FAILED')).channels)).toEqual(['inbox', 'sms']);

  const rows = await audits(s);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ app_id: s.appId, admin_id: s.a.id, action: ACTIONS.switch });
  expect(ms(rows[0]!.at)).toBe(now);
  expect(serialized(rows[0])).toContain('WD_FAILED');
  expect(serialized(rows[0]!.before)).not.toEqual(serialized(rows[0]!.after));

  // 再打开推送：回到三个渠道，版本再 +1，再一条审计。
  const back = await accepted<Item>(
    await s.switchChannels('WD_FAILED', { push: true, row_version: 6 }),
    'switch',
  );
  expect(sorted(back.channels)).toEqual(['inbox', 'push', 'sms']);
  expect(back.row_version).toBe(7);
  expect((await audits(s)).map((row) => row.action)).toEqual([ACTIONS.switch, ACTIONS.switch]);
});

it('[AC-B1-12z#14] 关短信（默认含短信的编码）：sms_state → disabled，推送与站内信不动；再打开（就绪）→ enabled，不要计费确认', async () => {
  const s = await setup(h);
  await seedWdFailed(s);
  const off = await accepted<Item>(
    await s.switchChannels('WD_FAILED', { sms: false, row_version: 5 }),
    'switch',
  );
  expect(sorted(off.channels)).toEqual(['inbox', 'push']);
  expect(off).toMatchObject({ sms_state: 'disabled', sms_ready: true, row_version: 6 });
  const on = await accepted<Item>(
    await s.switchChannels('WD_FAILED', { sms: true, row_version: 6 }),
    'switch',
  );
  expect(sorted(on.channels)).toEqual(['inbox', 'push', 'sms']);
  expect(on).toMatchObject({ sms_state: 'enabled', row_version: 7 });
});

it('[AC-B1-12z#15] 给默认不含短信的服务类编码开短信：不带或 confirm_sms_billing=false → 20001 [confirm_sms_billing]，什么都不写；带 true → 打开、enabled、审计一条', async () => {
  const s = await setup(h);
  await seedWdRejectedReady(s);
  const before = await snapshot(s);
  for (const body of [
    { sms: true, row_version: 3 },
    { sms: true, confirm_sms_billing: false, row_version: 3 },
  ]) {
    await rejected(await s.switchChannels('WD_REJECTED', body), 'switch', 20001, {
      fields: ['confirm_sms_billing'],
    });
    expect(await snapshot(s), JSON.stringify(body)).toEqual(before);
  }
  const data = await accepted<Item>(
    await s.switchChannels('WD_REJECTED', { sms: true, confirm_sms_billing: true, row_version: 3 }),
    'switch',
  );
  expect(sorted(data.channels)).toEqual(['inbox', 'push', 'sms']);
  expect(data).toMatchObject({ sms_billing_confirm: true, sms_state: 'enabled', row_version: 4 });
  for (const variant of ['default', 'negative_balance']) {
    expect(sorted((await templateRow(s, 'WD_REJECTED', variant)).channels), variant).toEqual([
      'inbox',
      'push',
      'sms',
    ]);
  }
  expect((await audits(s)).map((row) => row.action)).toEqual([ACTIONS.switch]);
});

it('[AC-B1-12z#16] 短信未就绪（有变体没有在用登记，待测试不算）时打开 → 20001 [sms]、不带 reason；先于计费确认', async () => {
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
    pending: { ...WD_REJECTED_NEGATIVE_ACTIVE, status: 'accepted' },
    rowVersion: 2,
  });
  const before = await snapshot(s);
  for (const body of [
    { sms: true, confirm_sms_billing: true, row_version: 2 },
    { sms: true, row_version: 2 },
  ]) {
    await rejected(await s.switchChannels('WD_REJECTED', body), 'switch', 20001, {
      fields: ['sms'],
    });
    expect(await snapshot(s), JSON.stringify(body)).toEqual(before);
  }
});

it('[AC-B1-12z#17] enabled_not_ready 的编码可以关短信；关了再开要就绪 → 20001 [sms]', async () => {
  const s = await setup(h);
  await seedTemplate(s, { code: 'WD_FAILED', channels: ['push', 'inbox', 'sms'], rowVersion: 1 });
  expect((await itemOf(s, 'WD_FAILED')).sms_state).toBe('enabled_not_ready');
  const off = await accepted<Item>(
    await s.switchChannels('WD_FAILED', { sms: false, row_version: 1 }),
    'switch',
  );
  expect(off).toMatchObject({ sms_state: 'disabled', sms_ready: false, row_version: 2 });
  expect(sorted(off.channels)).toEqual(['inbox', 'push']);
  const before = await snapshot(s);
  await rejected(
    await s.switchChannels('WD_FAILED', { sms: true, row_version: 2 }),
    'switch',
    20001,
    { fields: ['sms'] },
  );
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-12z#18] 不能开关的渠道 → 20001 notify_channel_locked：SMS_CODE、站长告警的短信不能关、不能开推送；只发站内信的编码两个都不能开；推送的锁先于短信', async () => {
  const s = await setup(h);
  await seedTemplate(s, {
    code: 'SMS_CODE',
    channels: ['sms'],
    active: SMS_CODE_ACTIVE,
    rowVersion: 1,
  });
  await seedTemplate(s, {
    code: 'UNION_AUTH_EXPIRED',
    channels: ['sms'],
    active: ALERT_ACTIVE,
    rowVersion: 1,
  });
  await seedTemplate(s, { code: 'BALANCE_ADJUSTED', channels: ['inbox'], rowVersion: 1 });
  await seedTemplate(s, { code: 'RISK_STATE_CHANGED', channels: ['inbox'], rowVersion: 1 });
  const before = await snapshot(s);
  const cases: [string, Record<string, unknown>, string][] = [
    ['SMS_CODE', { sms: false }, 'sms'],
    ['SMS_CODE', { sms: true }, 'sms'],
    ['SMS_CODE', { push: true }, 'push'],
    ['SMS_CODE', { push: true, sms: false }, 'push'],
    ['UNION_AUTH_EXPIRED', { sms: false }, 'sms'],
    ['UNION_AUTH_EXPIRED', { push: true }, 'push'],
    ['BALANCE_ADJUSTED', { push: true }, 'push'],
    ['BALANCE_ADJUSTED', { sms: true, confirm_sms_billing: true }, 'sms'],
    ['RISK_STATE_CHANGED', { push: true }, 'push'],
    ['RISK_STATE_CHANGED', { push: false }, 'push'],
  ];
  for (const [code, body, field] of cases) {
    await rejected(await s.switchChannels(code, { ...body, row_version: 1 }), 'switch', 20001, {
      fields: [field],
      reason: LOCKED,
    });
    expect(await snapshot(s), `${code} ${JSON.stringify(body)}`).toEqual(before);
  }
});

it('[AC-B1-12z#19] 已是请求的值：成功、不写（row_version 不变、没有审计）；只改其中一个时另一个原样', async () => {
  const s = await setup(h);
  await seedWdFailed(s);
  const before = await snapshot(s);
  const same = await accepted<Item>(
    await s.switchChannels('WD_FAILED', { push: true, sms: true, row_version: 5 }),
    'switch',
  );
  expect(same.row_version).toBe(5);
  expect(sorted(same.channels)).toEqual(['inbox', 'push', 'sms']);
  expect(await snapshot(s)).toEqual(before);

  const partly = await accepted<Item>(
    await s.switchChannels('WD_FAILED', { push: true, sms: false, row_version: 5 }),
    'switch',
  );
  expect(sorted(partly.channels)).toEqual(['inbox', 'push']);
  expect(partly.row_version).toBe(6);
  expect((await audits(s)).map((row) => row.action)).toEqual([ACTIONS.switch]);
});

it('[AC-B1-12z#20] row_version 与当前不符 → 20902、不带 data，什么都不写；可改性与就绪、计费确认的检查都先于它', async () => {
  const s = await setup(h);
  await seedWdFailed(s);
  await seedTemplate(s, { code: 'SMS_CODE', channels: ['sms'], rowVersion: 2 });
  await seedWdRejectedReady(s, 3);
  const before = await snapshot(s);
  for (const rowVersion of [4, 6, 0]) {
    await rejected(
      await s.switchChannels('WD_FAILED', { push: false, row_version: rowVersion }),
      'switch',
      20902,
    );
    expect(await snapshot(s), String(rowVersion)).toEqual(before);
  }
  await rejected(
    await s.switchChannels('SMS_CODE', { sms: false, row_version: 9 }),
    'switch',
    20001,
    { fields: ['sms'], reason: LOCKED },
  );
  // WD_REJECTED 两个变体都已启用（就绪）→ 计费确认先于 20902。
  await rejected(
    await s.switchChannels('WD_REJECTED', { sms: true, row_version: 9 }),
    'switch',
    20001,
    { fields: ['confirm_sms_billing'] },
  );
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-12z#21] 请求体按契约校验：push / sms 都没给 → 20001 [push, sms]；类型不对、缺 row_version、负数版本 → 20001 指明字段', async () => {
  const s = await setup(h);
  await seedWdFailed(s);
  const before = await snapshot(s);
  const cases: [Record<string, unknown>, string[]][] = [
    [{ row_version: 5 }, ['push', 'sms']],
    [{ confirm_sms_billing: true, row_version: 5 }, ['push', 'sms']],
    [{ push: 'off', row_version: 5 }, ['push']],
    [{ sms: 0, row_version: 5 }, ['sms']],
    [{ push: false }, ['row_version']],
    [{ push: false, row_version: -1 }, ['row_version']],
    [{ push: false, row_version: 1.5 }, ['row_version']],
  ];
  for (const [body, fields] of cases) {
    await rejected(await s.switchChannels('WD_FAILED', body), 'switch', 20001, { fields });
    expect(await snapshot(s), JSON.stringify(body)).toEqual(before);
  }
});

it('[AC-B1-12z#22] 不是本 app 的模板编码 → 20001 [code]，先于请求体校验；别的 app 的编码也一样', async () => {
  const s = await setup(h);
  const other = await setup(h);
  await seedWdFailed(other);
  const before = await snapshot(other);
  for (const body of [{ push: false, row_version: 5 }, { row_version: 5 }, {}]) {
    for (const code of ['NO_SUCH_CODE', 'WD_FAILED']) {
      await rejected(await s.switchChannels(code, body), 'switch', 20001, { fields: ['code'] });
    }
  }
  expect(await snapshot(other)).toEqual(before);
});

it('[AC-B1-12z#23] 每次都要有效的 totp 动态码：缺失、无效、他人会话的 → 10003 {tier: totp}；成功即消耗，同一令牌重放为 10003；动态码先于编码与请求体检查', async () => {
  const s = await setup(h);
  await seedWdFailed(s);
  const other = await signIn(h, s.f, s.appId);
  const before = await snapshot(s);
  for (const token of [null, 'invalid-step-up-token', await other.issue()]) {
    await rejected(
      await s.switchChannels('WD_FAILED', { push: false, row_version: 5 }, { token }),
      'switch',
      10003,
      STEP_UP,
    );
    await rejected(await s.switchChannels('NO_SUCH_CODE', {}, { token }), 'switch', 10003, STEP_UP);
    expect(await snapshot(s)).toEqual(before);
  }
  const token = await s.issue();
  await accepted(
    await s.switchChannels('WD_FAILED', { push: false, row_version: 5 }, { token }),
    'switch',
  );
  const after = await snapshot(s);
  await rejected(
    await s.switchChannels('WD_FAILED', { push: true, row_version: 6 }, { token }),
    'switch',
    10003,
    STEP_UP,
  );
  expect(await snapshot(s)).toEqual(after);
});

it('[AC-B1-12z#24] 只有 content.article（或只有 content.fund_terms）→ 10403，带不带动态码都一样，权限先于动态码；超管不勾权限点可以开关（仍要动态码）', async () => {
  for (const grants of [[ARTICLE], ['content.fund_terms']]) {
    const s = await setup(h, { grants });
    await seedWdFailed(s);
    const before = await snapshot(s);
    await rejected(
      await s.switchChannels('WD_FAILED', { push: false, row_version: 5 }),
      'switch',
      10403,
      DENIED,
    );
    await rejected(
      await s.switchChannels('WD_FAILED', { push: false, row_version: 5 }, { token: null }),
      'switch',
      10403,
      DENIED,
    );
    expect(await snapshot(s)).toEqual(before);
  }
  const s = await setup(h, { grants: [], isSuper: true });
  await seedWdFailed(s);
  await rejected(
    await s.switchChannels('WD_FAILED', { push: false, row_version: 5 }, { token: null }),
    'switch',
    10003,
    STEP_UP,
  );
  const data = await accepted<Item>(
    await s.switchChannels('WD_FAILED', { push: false, row_version: 5 }),
    'switch',
  );
  expect(data.row_version).toBe(6);
});
