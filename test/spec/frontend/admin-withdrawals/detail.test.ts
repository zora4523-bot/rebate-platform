// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BATCH,
  CONDITION_NAME,
  EXECUTOR,
  ID,
  NO,
  OTHER_GRANTS,
  PAYEE,
  REVIEWER,
  REVIEW_GRANTS,
  RISK_NAME,
  STATUS_NAME,
  VIEW_GRANTS,
  createServer,
  detailRoute,
  snapshot,
  type Server,
} from './fixtures.ts';
import {
  AMOUNT_LABEL,
  FLOW_TIMEOUT,
  FORBIDDEN,
  NOT_FOUND,
  detailShown,
  fieldValues,
  main,
  mount,
  openDetail,
  rowsOf,
  section,
  settled,
  showsYuan,
  squash,
  textOf,
} from './helpers.ts';

/** A full phone, card or account number (11–19 digits not inside an id or a withdrawal number). */
const FULL_NUMBER = /(?<![A-Za-z0-9-])\d{11,19}(?![0-9])/;
/** The 自动到账判定 section (结论、未满足条件). */
const DECISION = /自动到账判定|自动判定|判定结果|到账判定/;
/** The status history section (the stored time points, 处理记录 / 状态历史). */
const HISTORY = /状态历史|处理记录|状态记录|操作记录|流转记录|时间线|历史记录/;

async function direct(server: Server, id: string, number: string): Promise<HTMLElement> {
  await mount(server, { route: detailRoute(id) });
  return detailShown(server, id, number);
}

it(
  '[AC-F1-08a-DETAIL#1] 详情直达（已通过待执行的银行卡单，只持 fund.view）：只读该单，显示状态、金额明细四项各在其标签下（申请金额 / 手续费 / 代扣个税 / 实付金额，元）、批次与批次明细、生效冻结、收款账号只显示脱敏值',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    const area = await direct(server, ID.approved, NO.approved);
    expect(server.detailReads().map((read) => read.path)).toEqual(
      server.detailReads(ID.approved).map((read) => read.path),
    );
    const spaced = textOf(area);
    const text = squash(spaced);
    expect(text).toContain(STATUS_NAME.APPROVED);
    // Each amount under its own label, by hand from the fen (123456 / 100 / 2345 / 121011): the
    // four values differ, so two swapped fields fail.
    const expected = [
      { label: AMOUNT_LABEL.amount, yuan: '1234.56' },
      { label: AMOUNT_LABEL.fee, yuan: '1.00' },
      { label: AMOUNT_LABEL.tax, yuan: '23.45' },
      { label: AMOUNT_LABEL.net, yuan: '1210.11' },
    ];
    for (const { label, yuan } of expected)
      for (const value of fieldValues(area, label)) {
        expect(showsYuan(value, yuan), `${String(label)} shows ${yuan} (${value})`).toBe(true);
        for (const other of expected)
          if (other.yuan !== yuan)
            expect(showsYuan(value, other.yuan), `${String(label)} not ${other.yuan}`).toBe(false);
      }
    // The payee as the contract gives it: masked only.
    expect(text).toContain(squash(PAYEE.approved.masked_account));
    expect(text).toContain(PAYEE.approved.masked_name);
    expect(text).toContain(PAYEE.approved.bank_name);
    expect(spaced, 'no full account or phone number').not.toMatch(FULL_NUMBER);
    // The batch it is in and its batch item (blocked by the watermark).
    expect(text, 'batch').toContain(BATCH.approved.slice(0, 8));
    expect(text, 'batch item reason').toContain('watermark_below_forecast');
    expect(text, 'batch item result').toMatch(/blocked|受阻|阻断/);
    // The withdraw hold in effect (recon_diff, since 2026-10-21 01:05 Beijing time).
    expect(text, 'hold reason').toMatch(/recon_diff|对账差错/);
    expect(text, 'hold created_at').toContain('2026-10-2101:05');
    await settled(server);
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-DETAIL#2] 详情（待审核、转人工）：自动到账判定区显示结论与不满足的条件（max_amount 取字典中文名「超单笔自动上限」，risk_flag:first_withdrawal 显示中文名或编码）、风险标签、「暂停」标记、审核时限、申请金额、脱敏收款账号与姓名',
  async () => {
    const server = createServer(undefined, { permissions: REVIEW_GRANTS });
    const area = await direct(server, ID.pending, NO.pending);
    const spaced = textOf(area);
    const text = squash(spaced);
    expect(text).toContain(STATUS_NAME.PENDING_REVIEW);
    // The unmet conditions inside the decision section (not just the review mode's name).
    const decision = squash(textOf(section(area, DECISION)));
    expect(decision, 'unmet condition max_amount').toContain(CONDITION_NAME.max_amount);
    expect(decision, 'unmet condition risk_flag:first_withdrawal').toMatch(
      /首次提现|first_withdrawal/,
    );
    expect(decision, 'decision result').toMatch(/人工审核|转人工|manual/);
    expect(text, 'risk flag first_withdrawal').toContain(RISK_NAME.first_withdrawal!);
    expect(text, '「暂停」 of blocked_reason').toMatch(/暂停|NEGATIVE_BALANCE/);
    expect(text, 'review_deadline in Beijing time').toContain('2026-10-3010:00');
    for (const value of fieldValues(area, AMOUNT_LABEL.amount))
      expect(showsYuan(value, '500.00'), `申请金额 500.00 (${value})`).toBe(true);
    expect(text).toContain(PAYEE.pending.masked_account);
    expect(text).toContain(PAYEE.pending.masked_name);
    expect(spaced, 'no full account or phone number').not.toMatch(FULL_NUMBER);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-DETAIL#3] 详情（打款失败）：状态历史区显示各时间点（申请 09:00、执行 09:03），执行人，转账尝试摘要逐条显示类型、结果码与时间，批次号',
  async () => {
    const server = createServer();
    const area = await direct(server, ID.failed, NO.failed);
    const text = squash(textOf(area));
    expect(text).toContain(STATUS_NAME.FAILED);
    // The time points inside the history section; executed_at (09:03) is the only time point of
    // this sample in that minute (batch item 09:02, attempts 09:04 / 09:06).
    const history = squash(textOf(section(area, HISTORY)));
    expect(history, 'created_at in the history').toContain('2026-10-0509:00');
    expect(history, 'executed_at in the history').toContain('2026-10-0509:03');
    expect(text, 'executor').toContain(EXECUTOR.slice(0, 8));
    expect(text, 'batch').toContain(BATCH.failed.slice(0, 8));
    // Each attempt is a row of its own with its codes and time.
    const transfer = rowsOf(area, ['PAYEE_USER_INFO_ERROR']);
    expect(transfer, 'the transfer attempt row').toHaveLength(1);
    expect(squash(transfer[0]!.textContent)).toContain('PAYEE_NOT_EXIST');
    expect(squash(transfer[0]!.textContent)).toContain('09:04');
    expect(textOf(transfer[0]!)).toMatch(/transfer|转账|打款/);
    const queried = rowsOf(area, ['ORDER_FAIL']);
    expect(queried, 'the query attempt row').toHaveLength(1);
    expect(squash(queried[0]!.textContent)).toContain('09:06');
    expect(textOf(queried[0]!)).toMatch(/query|查询/);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-DETAIL#4] 从列表行【详情】进入（已驳回单）：读该单详情，显示审核人与审核时间、驳回原因码、自动到账判定区的不满足条件「当日入账当日提现」与风险标签中文名',
  async () => {
    const server = createServer();
    await mount(server);
    const area = await openDetail(server, NO.rejected, ID.rejected);
    expect(server.detailReads(ID.rejected).length).toBeGreaterThan(0);
    const text = squash(textOf(area));
    expect(text).toContain(STATUS_NAME.REJECTED);
    expect(text, 'reviewer').toContain(REVIEWER.slice(0, 8));
    expect(text, 'reviewed_at').toContain('2026-10-2015:30');
    expect(text, 'reject_reason_code').toMatch(/RISK_SUSPECT/);
    expect(squash(textOf(section(area, DECISION))), 'unmet condition same_day').toContain(
      CONDITION_NAME.same_day,
    );
    expect(text).toContain(RISK_NAME.same_device_multi_account!);
    expect(text).toContain(RISK_NAME.credited_today!);
    expect(text).toContain(PAYEE.rejected.masked_account);
    expect(text).toContain(PAYEE.rejected.masked_name);
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-DETAIL#5] 详情（微信零钱、打款中、等用户确认）：显示通道子状态与确认截止时间，转账尝试为处理中',
  async () => {
    const server = createServer();
    const area = await direct(server, ID.paying, NO.paying);
    const text = squash(textOf(area));
    expect(text).toContain(STATUS_NAME.PAYING);
    expect(text, 'channel_state').toMatch(/wait_user_confirm|等(?:待)?用户确认/);
    expect(text, 'confirm_deadline').toContain('2026-10-2614:00');
    expect(text, 'batch').toContain(BATCH.paying.slice(0, 8));
    expect(text).toContain(PAYEE.paying.masked_name);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-DETAIL#6] 不存在或他 app 的提现单（20001 [withdrawal_id]）：显示未找到类提示，不显示任何提现单数据',
  async () => {
    const server = createServer();
    await mount(server, { route: detailRoute(ID.unknown) });
    await waitFor(() => expect(server.detailReads(ID.unknown).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(NOT_FOUND));
    for (const number of Object.values(NO))
      expect(main().textContent, number).not.toContain(number);
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-DETAIL#7] 详情返回 10403：显示无权限提示，不显示单据数据',
  async () => {
    const server = createServer(undefined, { permissions: OTHER_GRANTS });
    await mount(server, { route: detailRoute(ID.pending), snapshot: snapshot(REVIEW_GRANTS) });
    await waitFor(() => expect(server.detailReads(ID.pending).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    expect(main().textContent).not.toContain(NO.pending);
    expect(main().textContent).not.toContain(PAYEE.pending.masked_account);
  },
  FLOW_TIMEOUT,
);
