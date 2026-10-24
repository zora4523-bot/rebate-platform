// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { LIST, PREVIEW, SIGN, TEMPLATE } from './fixtures.ts';
import { FLOW_TIMEOUT, actions, hasSmsRow, mount, openSms, smsRow, squash } from './helpers.ts';

it(
  '[AC-F1-06zv-SMS#1] 「短信」页签：已登记的 code × variant 行列出签名、模板 CODE、类型与预览正文，给【编辑】',
  async () => {
    const { server } = await mount();
    await openSms('SMS_CODE');
    expect(server.requests('GET', LIST)).toHaveLength(1);
    const registered = [
      { code: 'SMS_CODE', template: TEMPLATE.smsCode, type: /验证码/, preview: PREVIEW.smsCode },
      { code: 'WD_FAILED', template: TEMPLATE.wdFailed, type: /通知/, preview: PREVIEW.wdFailed },
      {
        code: 'UNION_AUTH_EXPIRING',
        template: TEMPLATE.unionExpiring,
        type: /通知/,
        preview: PREVIEW.unionExpiring,
      },
    ];
    for (const { code, template, type, preview } of registered) {
      const text = squash(smsRow(code).textContent);
      expect(text, code).toContain(SIGN);
      expect(text, code).toContain(template);
      expect(text, code).toMatch(type);
      expect(text, code).toContain(squash(preview));
      expect(text, code).not.toContain('未登记');
      expect(actions(smsRow(code), /^编辑/), `${code} 【编辑】`).toHaveLength(1);
      expect(actions(smsRow(code), /^登记/), `${code} no 【登记】`).toEqual([]);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SMS#2] 未登记的 code × variant 行显示「未登记」与【登记】；同一编码的两个变体各一行',
  async () => {
    await mount();
    await openSms('WD_REJECTED', 'negative_balance');
    const unregistered: [string, string][] = [
      ['WD_SUCCESS', 'default'],
      ['WD_REJECTED', 'default'],
      ['WD_REJECTED', 'negative_balance'],
      ['CLAIM_RESULT', 'default'],
    ];
    for (const [code, variant] of unregistered) {
      const row = smsRow(code, variant);
      expect(squash(row.textContent), `${code} · ${variant}`).toContain('未登记');
      expect(actions(row, /^登记/), `${code} · ${variant} 【登记】`).toHaveLength(1);
      expect(actions(row, /^编辑/), `${code} · ${variant} no 【编辑】`).toEqual([]);
    }
    expect(smsRow('WD_REJECTED', 'default')).not.toBe(smsRow('WD_REJECTED', 'negative_balance'));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-SMS#3] 只列 sms_registrations 非空的编码：只发站内信的 BALANCE_ADJUSTED 不出现',
  async () => {
    await mount();
    await openSms('SMS_CODE');
    expect(hasSmsRow('BALANCE_ADJUSTED')).toBe(false);
  },
  FLOW_TIMEOUT,
);
