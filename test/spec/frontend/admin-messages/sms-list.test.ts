// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { LIST, PREVIEW, SIGN, TEMPLATE, createServer, pending, withItem } from './fixtures.ts';
import {
  DISCARD,
  EDIT,
  FLOW_TIMEOUT,
  REGISTER,
  RETEST,
  STATUS,
  TEST_SEND,
  actions,
  hasSmsRow,
  mount,
  openSms,
  smsCell,
  smsRow,
  squash,
  statusOf,
} from './helpers.ts';

/** Title of the 类型 column (类型 / 模板类型 …). */
const TYPE_COLUMN = /类型$/;
/** Labels of sms_template_type (contracts/enums/admin.yaml): verify 验证码, notice 通知. */
const VERIFY_LABEL = /验证码/;
const NOTICE_LABEL = /通知/;
const NEW_CONFIG = '新配置';
const CODE_PREVIEW = '【凑狸】验证码${code}，5分钟内有效。';
/** Row buttons by name, in the order the expectations below list them. */
const NAMES: Record<string, RegExp> = {
  edit: EDIT,
  register: REGISTER,
  test: TEST_SEND,
  retest: RETEST,
  discard: DISCARD,
};

function rowText(code: string, variant = 'default'): string {
  return squash(smsRow(code, variant).textContent);
}
function typeText(code: string): string {
  return squash(smsCell(code, 'default', TYPE_COLUMN).textContent);
}

it(
  '[AC-F1-06zv-SMS#1] 「短信」页签：已启用的 code × variant 行列出签名、模板 CODE、类型与预览正文，状态「已启用」，给【编辑】',
  async () => {
    const { server } = await mount();
    await openSms('WD_SUCCESS');
    expect(server.requests('GET', LIST)).toHaveLength(1);
    const text = rowText('WD_SUCCESS');
    expect(text).toContain(SIGN);
    expect(text).toContain(TEMPLATE.wdSuccess);
    expect(text).toContain(squash(PREVIEW.wdSuccess));
    expect(typeText('WD_SUCCESS')).toMatch(NOTICE_LABEL);
    expect(typeText('WD_SUCCESS')).not.toMatch(VERIFY_LABEL);
    expect(statusOf('WD_SUCCESS')).toContain(STATUS.enabled);
    expect(statusOf('WD_SUCCESS')).not.toContain(STATUS.pending);
    expect(text).not.toContain(NEW_CONFIG);
    expect(actions(smsRow('WD_SUCCESS'), EDIT)).toHaveLength(1);
    expect(actions(smsRow('WD_SUCCESS'), REGISTER)).toEqual([]);
    expect(actions(smsRow('WD_SUCCESS'), DISCARD)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SMS#2] 状态列按 active / pending / test.status 画：测试失败（保留原配置继续生效）、待测试（测试已受理 / 未发送）、未登记',
  async () => {
    await mount();
    await openSms('WD_REJECTED', 'negative_balance');
    // WD_FAILED: active + pending failed.
    expect(statusOf('WD_FAILED')).toContain(STATUS.failed);
    expect(statusOf('WD_FAILED')).toMatch(/继续生效/);
    expect(statusOf('WD_FAILED')).not.toContain(STATUS.enabled);
    // WD_REJECTED default: no active, pending accepted (「稍后再启用」 leaves it here).
    expect(statusOf('WD_REJECTED')).toContain(STATUS.pending);
    expect(statusOf('WD_REJECTED')).toContain(STATUS.accepted);
    // WD_REJECTED negative_balance: pending, nothing sent (no verify phone when saved).
    expect(statusOf('WD_REJECTED', 'negative_balance')).toContain(STATUS.pending);
    expect(statusOf('WD_REJECTED', 'negative_balance')).not.toContain(STATUS.accepted);
    // UNION_AUTH_EXPIRING: active + pending accepted.
    expect(statusOf('UNION_AUTH_EXPIRING')).toContain(STATUS.pending);
    expect(statusOf('UNION_AUTH_EXPIRING')).toContain(STATUS.accepted);
    // DATA_COPY_CODE and CLAIM_RESULT: nothing registered.
    expect(statusOf('DATA_COPY_CODE')).toContain(STATUS.unregistered);
    expect(statusOf('CLAIM_RESULT')).toContain(STATUS.unregistered);
    // Each variant is a row of its own.
    expect(smsRow('WD_REJECTED', 'default')).not.toBe(smsRow('WD_REJECTED', 'negative_balance'));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SMS#3] 有新配置时同一行另列「新配置」与新模板 CODE，在用的模板 CODE 照列',
  async () => {
    await mount();
    await openSms('WD_FAILED');
    const failed = rowText('WD_FAILED');
    expect(failed).toContain(TEMPLATE.wdFailedActive);
    expect(failed).toContain(TEMPLATE.wdFailedPending);
    expect(failed).toContain(NEW_CONFIG);
    const union = rowText('UNION_AUTH_EXPIRING');
    expect(union).toContain(TEMPLATE.unionActive);
    expect(union).toContain(TEMPLATE.unionPending);
    expect(union).toContain(NEW_CONFIG);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SMS#4] 各状态的行按钮：测试失败给【编辑】【重新测试】【放弃新配置】；待测试给【编辑】【测试发送】（有在用配置时另给【放弃新配置】）；未登记只给【登记】',
  async () => {
    await mount();
    await openSms('WD_REJECTED', 'negative_balance');
    const expected: [string, string, string[]][] = [
      ['WD_FAILED', 'default', ['edit', 'retest', 'discard']],
      ['UNION_AUTH_EXPIRING', 'default', ['edit', 'test', 'discard']],
      ['WD_REJECTED', 'default', ['edit', 'test']],
      ['WD_REJECTED', 'negative_balance', ['edit', 'test']],
      ['DATA_COPY_CODE', 'default', ['register']],
      ['CLAIM_RESULT', 'default', ['register']],
    ];
    for (const [code, variant, offered] of expected) {
      const row = smsRow(code, variant);
      const shown = Object.keys(NAMES).filter((key) => actions(row, NAMES[key]!).length === 1);
      expect(shown, `${code} · ${variant}`).toEqual(offered);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SMS#5] SMS_CODE 没有在用配置（sms_deploy_fallback）：状态显示「部署配置兜底」并给【登记】',
  async () => {
    await mount();
    await openSms('SMS_CODE');
    expect(statusOf('SMS_CODE')).toContain(STATUS.fallback);
    expect(actions(smsRow('SMS_CODE'), REGISTER)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SMS#6] SMS_CODE 首次登记待测试（部署配置兜底仍在）：状态同时显示「待测试」与「部署配置兜底」，并列出新模板 CODE',
  async () => {
    const data = withItem('SMS_CODE', {
      sms_registrations: [
        {
          variant: 'default',
          variables: ['code'],
          active: null,
          pending: pending(TEMPLATE.fresh, CODE_PREVIEW, 'accepted', 'verify'),
        },
      ],
    });
    await mount(createServer(data));
    await openSms('SMS_CODE');
    expect(statusOf('SMS_CODE')).toContain(STATUS.pending);
    expect(statusOf('SMS_CODE')).toContain(STATUS.fallback);
    expect(rowText('SMS_CODE')).toContain(TEMPLATE.fresh);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SMS#7] 只列 sms_registrations 非空的编码：只发站内信的 BALANCE_ADJUSTED 与订阅类 WATCH_DIGEST 不出现',
  async () => {
    await mount();
    await openSms('WD_FAILED');
    expect(hasSmsRow('BALANCE_ADJUSTED')).toBe(false);
    expect(hasSmsRow('WATCH_DIGEST')).toBe(false);
  },
  FLOW_TIMEOUT,
);
