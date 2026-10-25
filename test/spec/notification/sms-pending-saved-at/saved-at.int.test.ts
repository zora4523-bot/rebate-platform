// 规则测试（B1-12zb；编排裁定 D10-355 ①；契约 CT-24t：pending.saved_at 字段形状不变；08 BR-TEXT-20 细则
// 「短信渠道登记与后台渠道开关」的「待测试」登记）：
// - notify_templates 加 sms_pending_saved_at（timestamptz、可空、无默认、不回填），不并入待测试六列的
//   all-or-none CHECK：只有六列的待测试行照旧可写。
// - 保存待测试（PUT …/sms 走测试发送：受理 / 未受理 / 未发送）写 sms_pending_saved_at = Clock 此刻；
//   重新测试只改 sms_test_status / sms_tested_at，列为空时先把更新前的 sms_tested_at 写入它；
//   启用、放弃与其余待测试列一起清空。
// - 列表与保存 / 重新测试响应的 pending.saved_at 取 sms_pending_saved_at，为空回退 sms_tested_at。
// 新列不在生成的 DB 类型里：读写它一律用 sql；读它之前先在目录里断言它存在（未迁移的库须是断言失败）。
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { useHarness, type Harness } from '../../admin/auth/kit.ts';
import {
  SEEDED_TESTED_AT,
  WD_FAILED_ACTIVE,
  WD_FAILED_PENDING,
  WD_REJECTED_ACTIVE,
  WD_REJECTED_NEGATIVE_ACTIVE,
  accepted,
  itemOf,
  ms,
  pendingOf,
  previewWith,
  rejected,
  seedTemplate,
  setup,
  smsOf,
  templateRow,
  variablesOf,
  variantOf,
  type Item,
  type Scenario,
  type SmsResult,
  type Where,
} from '../admin-channels/kit.ts';

const h = useHarness();

const COLUMN = 'sms_pending_saved_at';
/** 两次操作之间额外推进的时间（每次取二次验证令牌另推进 30 秒）。 */
const LATER_MS = 60_000;
/** 直接写进新列的保存时刻：早于种子里的测试时间，与它区分得开。 */
const STORED_SAVED_AT = new Date('2026-10-07T23:30:00.000Z');

const WD_REJECTED_PENDING = pendingOf(WD_REJECTED_ACTIVE, 'accepted', 'SMS_540000023');
const WD_NEGATIVE_PENDING = pendingOf(WD_REJECTED_NEGATIVE_ACTIVE, 'failed', 'SMS_540000024');

async function requireSavedAtColumn(harness: Harness): Promise<void> {
  const result = await sql<{
    name: string;
    type: string;
    nullable: boolean;
    default_value: string | null;
  }>`
    SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable,
           column_default AS default_value
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'notify_templates' AND column_name = ${COLUMN}
  `.execute(harness.db);
  expect(result.rows, `notify_templates.${COLUMN}`).toEqual([
    { name: COLUMN, type: 'timestamptz', nullable: true, default_value: null },
  ]);
}

/** 一行（code × variant）的 sms_pending_saved_at（毫秒；null = 空）。 */
async function savedAtColumn(s: Where, code: string, variant = 'default'): Promise<number | null> {
  const result = await sql<{ saved_at: Date | null }>`
    SELECT sms_pending_saved_at AS saved_at FROM app.notify_templates
    WHERE app_id = ${s.appId} AND code = ${code} AND variant = ${variant}
  `.execute(s.h.db);
  expect(result.rows, `${code} × ${variant}`).toHaveLength(1);
  return ms(result.rows[0]!.saved_at);
}

async function setSavedAtColumn(s: Where, code: string, value: Date, variant = 'default') {
  const result = await sql`
    UPDATE app.notify_templates SET sms_pending_saved_at = ${value}
    WHERE app_id = ${s.appId} AND code = ${code} AND variant = ${variant}
  `.execute(s.h.db);
  expect(result.numAffectedRows).toBe(1n);
}

/** 一项里某变体「待测试」的保存时刻与测试时刻（毫秒）。 */
function pendingTimes(item: Item, variant = 'default') {
  const pending = variantOf(item, variant).pending;
  expect(pending, `${item.code} × ${variant} has a pending registration`).not.toBeNull();
  return { saved: ms(pending!.saved_at), tested: ms(pending!.test.tested_at) };
}

/** WD_FAILED 的一份新登记（走测试发送）：用列表给出的变量拼预览正文。 */
async function wdFailedBody(s: Scenario, templateCode: string, rowVersion: number) {
  const variables = await variablesOf(s, 'WD_FAILED');
  return {
    sign_name: '凑狸',
    template_code: templateCode,
    template_type: 'notice',
    preview_text: previewWith(variables),
    row_version: rowVersion,
  };
}

/** WD_REJECTED 某变体的一份新登记（走测试发送）。 */
async function wdRejectedBody(
  s: Scenario,
  variant: string,
  templateCode: string,
  rowVersion: number,
) {
  const variables = await variablesOf(s, 'WD_REJECTED', variant);
  return {
    sign_name: '凑狸',
    template_code: templateCode,
    template_type: 'notice',
    preview_text: previewWith(variables),
    row_version: rowVersion,
  };
}

async function seedWdFailed(s: Where, rowVersion = 5) {
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    rowVersion,
  });
}

it('[AC-B1-12zb#1] notify_templates 加 sms_pending_saved_at：timestamptz、可空、无默认；只有六列的待测试行照旧可写、新列读作空；七列齐全也可写；随表授权（couli_app 读写、couli_readonly 只读）', async () => {
  const s = await setup(h);
  await requireSavedAtColumn(h);
  // 只写六列（不写新列）的待测试行：照旧可写，新列为空（不回填、无默认）。
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    pending: WD_FAILED_PENDING,
    rowVersion: 5,
  });
  expect(await savedAtColumn(s, 'WD_FAILED')).toBeNull();
  expect(await templateRow(s, 'WD_FAILED')).toMatchObject({
    sms_pending_template_code: WD_FAILED_PENDING.templateCode,
    sms_test_status: WD_FAILED_PENDING.status,
  });
  // 七列齐全的待测试行：可写、读回原值。
  await setSavedAtColumn(s, 'WD_FAILED', STORED_SAVED_AT);
  expect(await savedAtColumn(s, 'WD_FAILED')).toBe(STORED_SAVED_AT.getTime());
  // 没有待测试的行：新列为空。
  await seedTemplate(s, { code: 'SMS_CODE', channels: ['sms'] });
  expect(await savedAtColumn(s, 'SMS_CODE')).toBeNull();

  for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
      const allowed = role === 'couli_app' || (role === 'couli_readonly' && privilege === 'SELECT');
      const result = await sql<{ allowed: boolean }>`SELECT
        has_column_privilege(${role}, ${'app.notify_templates'}, ${COLUMN}, ${privilege}) AS allowed
      `.execute(h.db);
      expect(result.rows, `${role} notify_templates.${COLUMN} ${privilege}`).toEqual([{ allowed }]);
    }
  }
});

it('[AC-B1-12zb#2] 保存待测试（测试受理 / 被拒 50301 / 超时 50401 / 没有验证手机号未发送）：sms_pending_saved_at = 保存时刻，响应与列表的 saved_at 都是它', async () => {
  for (const [result, code] of [
    ['accepted', 0],
    ['rejected', 50301],
    ['unknown', 50401],
  ] as const) {
    const s = await setup(h);
    await requireSavedAtColumn(h);
    await seedWdFailed(s);
    const sms = smsOf(s.f);
    sms.enqueueResult(result);
    const body = await wdFailedBody(s, 'SMS_520000023', 5);
    const response = await s.register('WD_FAILED', body);
    const now = s.f.clock.now().getTime();
    if (code === 0) {
      const data = await accepted<SmsResult>(response, 'register');
      expect(pendingTimes(data.item), result).toEqual({ saved: now, tested: now });
    } else {
      await rejected(response, 'register', code);
    }
    expect(sms.outbox(), result).toHaveLength(1);
    expect(pendingTimes(await itemOf(s, 'WD_FAILED')), result).toEqual({ saved: now, tested: now });
    expect(await savedAtColumn(s, 'WD_FAILED'), result).toBe(now);
  }

  const noPhone = await setup(h, { verifyPhone: false });
  await requireSavedAtColumn(h);
  await seedWdFailed(noPhone);
  const data = await accepted<SmsResult>(
    await noPhone.register('WD_FAILED', await wdFailedBody(noPhone, 'SMS_520000024', 5)),
    'register',
  );
  const now = noPhone.f.clock.now().getTime();
  expect(variantOf(data.item).pending?.test.status).toBe('not_sent_no_verify_phone');
  expect(pendingTimes(data.item)).toEqual({ saved: now, tested: now });
  expect(pendingTimes(await itemOf(noPhone, 'WD_FAILED'))).toEqual({ saved: now, tested: now });
  expect(await savedAtColumn(noPhone, 'WD_FAILED')).toBe(now);
  expect(smsOf(noPhone.f).outbox()).toEqual([]);
});

it('[AC-B1-12zb#3] 重新测试不改保存时刻：推进时钟后重新测试（受理、被拒都算），saved_at 仍是保存时刻而 tested_at 换成此刻；再保存一份新登记才换成新的保存时刻', async () => {
  const s = await setup(h);
  await seedWdFailed(s);
  const sms = smsOf(s.f);
  await accepted<SmsResult>(
    await s.register('WD_FAILED', await wdFailedBody(s, 'SMS_520000025', 5)),
    'register',
  );
  const savedAt = s.f.clock.now().getTime();

  s.f.clock.advanceMs(LATER_MS);
  const retested = await accepted<SmsResult>(
    await s.retest('WD_FAILED', { row_version: 6 }),
    'retest',
  );
  const firstTest = s.f.clock.now().getTime();
  expect(firstTest).toBeGreaterThan(savedAt);
  expect(retested.item.row_version).toBe(7);
  expect(variantOf(retested.item).pending?.test.status).toBe('accepted');
  expect(pendingTimes(retested.item)).toEqual({ saved: savedAt, tested: firstTest });
  expect(pendingTimes(await itemOf(s, 'WD_FAILED'))).toEqual({ saved: savedAt, tested: firstTest });

  s.f.clock.advanceMs(LATER_MS);
  sms.enqueueResult('rejected');
  await rejected(await s.retest('WD_FAILED', { row_version: 7 }), 'retest', 50301);
  const secondTest = s.f.clock.now().getTime();
  const item = await itemOf(s, 'WD_FAILED');
  expect(item.row_version).toBe(8);
  expect(variantOf(item).pending?.test.status).toBe('failed');
  expect(pendingTimes(item)).toEqual({ saved: savedAt, tested: secondTest });

  await requireSavedAtColumn(h);
  expect(await savedAtColumn(s, 'WD_FAILED')).toBe(savedAt);
  expect(ms((await templateRow(s, 'WD_FAILED')).sms_tested_at)).toBe(secondTest);

  // 已有「待测试」时再保存一份新登记：替换原「待测试」，保存时刻是这次保存。
  s.f.clock.advanceMs(LATER_MS);
  const saved = await accepted<SmsResult>(
    await s.register('WD_FAILED', await wdFailedBody(s, 'SMS_520000026', 8)),
    'register',
  );
  const resavedAt = s.f.clock.now().getTime();
  expect(variantOf(saved.item).pending?.template_code).toBe('SMS_520000026');
  expect(pendingTimes(saved.item)).toEqual({ saved: resavedAt, tested: resavedAt });
  expect(await savedAtColumn(s, 'WD_FAILED')).toBe(resavedAt);
});

it('[AC-B1-12zb#4] 只有六列的旧待测试行：列表回退 sms_tested_at；首次重新测试（受理或超时）把原 tested_at 冻结进 sms_pending_saved_at，此后 saved_at 一直是它；别的变体不动', async () => {
  const s = await setup(h);
  for (const [variant, pending] of [
    ['default', WD_REJECTED_PENDING],
    ['negative_balance', WD_NEGATIVE_PENDING],
  ] as const) {
    await seedTemplate(s, {
      code: 'WD_REJECTED',
      variant,
      channels: ['push', 'inbox'],
      pending,
      rowVersion: 4,
    });
  }
  const sms = smsOf(s.f);
  const seeded = SEEDED_TESTED_AT.getTime();
  const before = await itemOf(s, 'WD_REJECTED');
  expect(pendingTimes(before)).toEqual({ saved: seeded, tested: seeded });
  expect(pendingTimes(before, 'negative_balance')).toEqual({ saved: seeded, tested: seeded });

  const first = await accepted<SmsResult>(
    await s.retest('WD_REJECTED', { row_version: 4 }),
    'retest',
  );
  const firstTest = s.f.clock.now().getTime();
  expect(firstTest).toBeGreaterThan(seeded);
  expect(pendingTimes(first.item)).toEqual({ saved: seeded, tested: firstTest });
  expect(pendingTimes(first.item, 'negative_balance')).toEqual({ saved: seeded, tested: seeded });

  s.f.clock.advanceMs(LATER_MS);
  const second = await accepted<SmsResult>(
    await s.retest('WD_REJECTED', { row_version: 5 }),
    'retest',
  );
  const secondTest = s.f.clock.now().getTime();
  expect(pendingTimes(second.item)).toEqual({ saved: seeded, tested: secondTest });
  expect(pendingTimes(await itemOf(s, 'WD_REJECTED'))).toEqual({
    saved: seeded,
    tested: secondTest,
  });

  await requireSavedAtColumn(h);
  expect(await savedAtColumn(s, 'WD_REJECTED')).toBe(seeded);
  expect(await savedAtColumn(s, 'WD_REJECTED', 'negative_balance')).toBeNull();

  // 旧行首次重新测试的结果未知（50401）：同样冻结。
  s.f.clock.advanceMs(LATER_MS);
  sms.enqueueResult('unknown');
  await rejected(
    await s.retest('WD_REJECTED', { row_version: 6 }, { variant: 'negative_balance' }),
    'retest',
    50401,
  );
  const thirdTest = s.f.clock.now().getTime();
  const item = await itemOf(s, 'WD_REJECTED');
  expect(item.row_version).toBe(7);
  expect(pendingTimes(item, 'negative_balance')).toEqual({ saved: seeded, tested: thirdTest });
  expect(pendingTimes(item)).toEqual({ saved: seeded, tested: secondTest });
  expect(await savedAtColumn(s, 'WD_REJECTED', 'negative_balance')).toBe(seeded);
  expect(await savedAtColumn(s, 'WD_REJECTED')).toBe(seeded);
});

it('[AC-B1-12zb#5] saved_at 取 sms_pending_saved_at（不为空时不看 sms_tested_at）：列表、重新测试响应都是它，重新测试不覆盖它；就地改在用登记也不动它', async () => {
  const s = await setup(h);
  await seedTemplate(s, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    pending: WD_FAILED_PENDING,
    rowVersion: 5,
  });
  await requireSavedAtColumn(h);
  await setSavedAtColumn(s, 'WD_FAILED', STORED_SAVED_AT);
  const stored = STORED_SAVED_AT.getTime();
  const seeded = SEEDED_TESTED_AT.getTime();
  expect(pendingTimes(await itemOf(s, 'WD_FAILED'))).toEqual({ saved: stored, tested: seeded });

  const retested = await accepted<SmsResult>(
    await s.retest('WD_FAILED', { row_version: 5 }),
    'retest',
  );
  const testedAt = s.f.clock.now().getTime();
  expect(pendingTimes(retested.item)).toEqual({ saved: stored, tested: testedAt });
  expect(await savedAtColumn(s, 'WD_FAILED')).toBe(stored);

  // 签名与模板 CODE 同在用登记：就地改正文，「待测试」与它的保存时刻原样。
  s.f.clock.advanceMs(LATER_MS);
  const variables = await variablesOf(s, 'WD_FAILED');
  const edited = await accepted<SmsResult>(
    await s.register('WD_FAILED', {
      sign_name: WD_FAILED_ACTIVE.signName,
      template_code: WD_FAILED_ACTIVE.templateCode,
      template_type: 'notice',
      preview_text: previewWith(variables, '可在App内查看原因。'),
      row_version: 6,
    }),
    'register',
  );
  expect(edited.test_send_phone_masked).toBeNull();
  expect(pendingTimes(edited.item)).toEqual({ saved: stored, tested: testedAt });
  expect(pendingTimes(await itemOf(s, 'WD_FAILED'))).toEqual({ saved: stored, tested: testedAt });
  expect(await savedAtColumn(s, 'WD_FAILED')).toBe(stored);
});

it('[AC-B1-12zb#6] 启用、放弃时 sms_pending_saved_at 与其余待测试列一起清空；之后再保存的登记取新的保存时刻', async () => {
  const s = await setup(h);
  for (const variant of ['default', 'negative_balance']) {
    await seedTemplate(s, {
      code: 'WD_REJECTED',
      variant,
      channels: ['push', 'inbox'],
      rowVersion: 2,
    });
  }
  await requireSavedAtColumn(h);

  await accepted<SmsResult>(
    await s.register('WD_REJECTED', await wdRejectedBody(s, 'default', 'SMS_540000025', 2)),
    'register',
  );
  const savedAt = s.f.clock.now().getTime();
  expect(await savedAtColumn(s, 'WD_REJECTED')).toBe(savedAt);
  const enabled = await accepted<Item>(await s.enable('WD_REJECTED', { row_version: 3 }), 'enable');
  expect(variantOf(enabled).pending).toBeNull();
  expect(await savedAtColumn(s, 'WD_REJECTED')).toBeNull();
  expect(await templateRow(s, 'WD_REJECTED')).toMatchObject({
    sms_template_code: 'SMS_540000025',
    sms_pending_template_code: null,
    sms_test_status: null,
    sms_tested_at: null,
  });

  await accepted<SmsResult>(
    await s.register(
      'WD_REJECTED',
      await wdRejectedBody(s, 'negative_balance', 'SMS_540000026', 4),
      { variant: 'negative_balance' },
    ),
    'register',
  );
  const negativeSavedAt = s.f.clock.now().getTime();
  expect(negativeSavedAt).toBeGreaterThan(savedAt);
  expect(await savedAtColumn(s, 'WD_REJECTED', 'negative_balance')).toBe(negativeSavedAt);
  const discarded = await accepted<Item>(
    await s.discard('WD_REJECTED', { variant: 'negative_balance', row_version: 5 }),
    'discard',
  );
  expect(variantOf(discarded, 'negative_balance').pending).toBeNull();
  expect(await savedAtColumn(s, 'WD_REJECTED', 'negative_balance')).toBeNull();
  expect(await templateRow(s, 'WD_REJECTED', 'negative_balance')).toMatchObject({
    sms_pending_template_code: null,
    sms_test_status: null,
    sms_tested_at: null,
  });

  // 旧行首次重新测试冻结的保存时刻，放弃时同样清空。
  const legacy = await setup(h);
  await seedTemplate(legacy, {
    code: 'WD_FAILED',
    channels: ['push', 'inbox', 'sms'],
    active: WD_FAILED_ACTIVE,
    pending: WD_FAILED_PENDING,
    rowVersion: 5,
  });
  await accepted<SmsResult>(await legacy.retest('WD_FAILED', { row_version: 5 }), 'retest');
  expect(await savedAtColumn(legacy, 'WD_FAILED')).toBe(SEEDED_TESTED_AT.getTime());
  await accepted<Item>(
    await legacy.discard('WD_FAILED', { variant: 'default', row_version: 6 }),
    'discard',
  );
  expect(await savedAtColumn(legacy, 'WD_FAILED')).toBeNull();

  // 清空之后再保存：保存时刻是新的这次，不是旧值。
  s.f.clock.advanceMs(LATER_MS);
  const resaved = await accepted<SmsResult>(
    await s.register('WD_REJECTED', await wdRejectedBody(s, 'default', 'SMS_540000027', 6)),
    'register',
  );
  const resavedAt = s.f.clock.now().getTime();
  expect(pendingTimes(resaved.item)).toEqual({ saved: resavedAt, tested: resavedAt });
  expect(await savedAtColumn(s, 'WD_REJECTED')).toBe(resavedAt);
});
