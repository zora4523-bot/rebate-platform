// 规则测试（B1-12z 第 2 次，spec-test r1 补充；契约 CT-24t adminRegisterNotifySms / adminRetestNotifySms 的
// 「保存与测试结果在阿里云答复后、按前面校验的 row_version 一个事务写入（期间编码被改 → 20902，测试短信可能
// 已发出）」；编排技术决定 B.4）：假测试发送器在答复前执行一个回调，回调里另一管理员对同一编码做一次写操作
// （登记 / 开关 / 放弃）；进行中的重新测试与登记都返回 20902、不带 data，什么都不写（含审计），另一写操作的
// 结果原样保留。
import { expect, it } from 'vitest';
import type { NotifySmsTestMessage } from '../../../../apps/api/src/modules/notification/admin-channels/sms-test-sender.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  WD_FAILED_ACTIVE,
  WD_FAILED_PENDING,
  accepted,
  audits,
  itemOf,
  pendingOf,
  previewWith,
  rejected,
  seedTemplate,
  setup,
  signIn,
  smsOf,
  snapshot,
  sorted,
  templateRow,
  variablesOf,
  variantOf,
  type Admin,
  type Item,
  type Scenario,
  type SmsResult,
} from './kit.ts';

const h = useHarness();

type Rival = 'register' | 'switch' | 'discard';
const RIVALS: readonly Rival[] = ['register', 'switch', 'discard'];
const RIVAL_ACTION: Readonly<Record<Rival, string>> = {
  register: ACTIONS.register,
  switch: ACTIONS.switch,
  discard: ACTIONS.discard,
};
const RIVAL_TEMPLATE_CODE = 'SMS_520000007';

/** WD_FAILED：推送 + 站内 + 短信、在用登记、测试已受理的「待测试」，版本 5。 */
async function seedWdFailed(s: Scenario) {
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    pending: pendingOf(WD_FAILED_PENDING, 'accepted'),
    rowVersion: 5,
  });
}

/** 另一管理员对 WD_FAILED 的一次写操作（按版本 5），须成功、版本到 6。 */
async function rivalWrite(other: Admin, rival: Rival, variables: readonly string[]) {
  if (rival === 'register') {
    const data = await accepted<SmsResult>(
      await other.register('WD_FAILED', {
        sign_name: '凑狸',
        template_code: RIVAL_TEMPLATE_CODE,
        template_type: 'notice',
        preview_text: previewWith(variables, '可在App内查看。'),
        row_version: 5,
      }),
      'register',
    );
    expect(data.item.row_version).toBe(6);
    expect(variantOf(data.item).pending?.template_code).toBe(RIVAL_TEMPLATE_CODE);
    return;
  }
  const data =
    rival === 'switch'
      ? await accepted<Item>(
          await other.switchChannels('WD_FAILED', { push: false, row_version: 5 }),
          'switch',
        )
      : await accepted<Item>(await other.discard('WD_FAILED', { row_version: 5 }), 'discard');
  expect(data.row_version).toBe(6);
}

/** 另一写操作留下的、各自可辨认的结果。 */
async function expectRivalKept(s: Scenario, rival: Rival) {
  const item = await itemOf(s, 'WD_FAILED');
  expect(item.row_version, rival).toBe(6);
  expect(variantOf(item).active?.template_code, rival).toBe(WD_FAILED_ACTIVE.templateCode);
  const row = await templateRow(s, 'WD_FAILED');
  if (rival === 'register') {
    expect(row.sms_pending_template_code).toBe(RIVAL_TEMPLATE_CODE);
    expect(sorted(row.channels)).toEqual(['inbox', 'push', 'sms']);
  } else if (rival === 'switch') {
    expect(sorted(row.channels)).toEqual(['inbox', 'sms']);
    expect(row.sms_pending_template_code).toBe(WD_FAILED_PENDING.templateCode);
  } else {
    expect(row.sms_pending_template_code).toBeNull();
    expect(row.sms_test_status).toBeNull();
    expect(sorted(row.channels)).toEqual(['inbox', 'push', 'sms']);
  }
  expect(
    (await audits(s)).map((r) => r.action),
    rival,
  ).toEqual([RIVAL_ACTION[rival]]);
}

for (const rival of RIVALS) {
  it(`[AC-B1-12z#59] 重新测试进行中（测试短信已发出、答复前）另一管理员${rival}同一编码 → 重新测试 20902、不带 data，什么都不写；另一写操作的结果原样保留`, async () => {
    const s = await setup(h);
    await seedWdFailed(s);
    const other = await signIn(h, s.f, s.appId);
    const variables = await variablesOf(s, 'WD_FAILED');
    const sms = smsOf(s.f);
    let seen: NotifySmsTestMessage | undefined;
    let afterRival: Awaited<ReturnType<typeof snapshot>> | undefined;
    sms.beforeNextAnswer(async (message) => {
      seen = message;
      await rivalWrite(other, rival, variables);
      afterRival = await snapshot(s);
    });

    await rejected(await s.retest('WD_FAILED', { row_version: 5 }), 'retest', 20902);
    expect(seen, '回调在重新测试的发送里执行').toMatchObject({
      appId: s.appId,
      phone: s.phone,
      templateCode: WD_FAILED_PENDING.templateCode,
    });
    expect(afterRival).toBeDefined();
    expect(await snapshot(s)).toEqual(afterRival);
    await expectRivalKept(s, rival);
    expect(sms.outbox().map((m) => m.templateCode)).toEqual(
      rival === 'register'
        ? [WD_FAILED_PENDING.templateCode, RIVAL_TEMPLATE_CODE]
        : [WD_FAILED_PENDING.templateCode],
    );
  });
}

for (const rival of RIVALS) {
  it(`[AC-B1-12z#60] 登记进行中（测试短信已发出、答复前）另一管理员${rival}同一编码 → 登记 20902、不带 data，新登记不落库、不写审计；另一写操作的结果原样保留`, async () => {
    const s = await setup(h);
    await seedWdFailed(s);
    const other = await signIn(h, s.f, s.appId);
    const variables = await variablesOf(s, 'WD_FAILED');
    const sms = smsOf(s.f);
    let seen: NotifySmsTestMessage | undefined;
    let afterRival: Awaited<ReturnType<typeof snapshot>> | undefined;
    sms.beforeNextAnswer(async (message) => {
      seen = message;
      await rivalWrite(other, rival, variables);
      afterRival = await snapshot(s);
    });

    await rejected(
      await s.register('WD_FAILED', {
        sign_name: '凑狸',
        template_code: 'SMS_520000003',
        template_type: 'notice',
        preview_text: previewWith(variables),
        row_version: 5,
      }),
      'register',
      20902,
    );
    expect(seen, '回调在登记的测试发送里执行').toMatchObject({
      appId: s.appId,
      phone: s.phone,
      templateCode: 'SMS_520000003',
    });
    expect(afterRival).toBeDefined();
    expect(await snapshot(s)).toEqual(afterRival);
    await expectRivalKept(s, rival);
    expect((await templateRow(s, 'WD_FAILED')).sms_pending_template_code).not.toBe('SMS_520000003');
    expect(sms.outbox().map((m) => m.templateCode)).toEqual(
      rival === 'register' ? ['SMS_520000003', RIVAL_TEMPLATE_CODE] : ['SMS_520000003'],
    );
  });
}
