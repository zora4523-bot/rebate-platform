// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import {
  ORDERS,
  PLATFORM_SHOWN,
  SUPER,
  UID,
  WITHDRAWALS,
  dictName,
  parentClaims,
  parentOrders,
  parentWithdrawals,
  uidClaims,
  uidOrders,
  uidWithdrawals,
  yuan,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  cellUnder,
  clean,
  finish,
  mount,
  openRow,
  openTab,
  openUser,
  rowShown,
  rowWith,
  rowsWith,
  settled,
  squash,
  tabRow,
} from './helpers.ts';

afterEach(finish);

/** Payment / application times in Beijing (UTC+8), worked out by hand from the fixtures. */
const ORDER_PAID_AT: Readonly<Record<string, string>> = {
  '260930-1000000001': '2026-10-07 01:05',
  '260930-1000000002': '2026-10-06 00:30',
  '260930-1000000003': '2026-10-04 19:45',
};
const CLAIM_SUBMITTED_AT: Readonly<Record<string, string>> = {
  'cccccccc-0000-4000-8000-000000000001': '2026-10-12 00:20',
  'cccccccc-0000-4000-8000-000000000002': '2026-10-10 11:00',
};
const WITHDRAWAL_CREATED_AT: Readonly<Record<string, string>> = {
  W20261021000001: '2026-10-21 02:30',
  W20261019000002: '2026-10-19 10:00',
};
/** Review time of the withdrawals reviewed so far (another minute than their application). */
const WITHDRAWAL_REVIEWED_AT: Readonly<Record<string, string>> = {
  W20261021000001: '2026-10-21 03:47',
};

/** The application time column (申请时间, or a bare 时间 column). */
const appliedAtColumn = (title: string): boolean =>
  (/申请|创建|提交/.test(title) && /时间|日期|于/.test(title)) || title === '时间';
/** A review time column, when the tab has one (not 审核方式 and the like). */
const reviewedAtColumn = (title: string): boolean =>
  /审核/.test(title) && /时间|日期|于/.test(title);

/** Column titles of the table `row` sits in. */
function columnTitles(row: HTMLElement): string[] {
  const header = (row.closest('.ant-table') ?? row.closest('table'))?.querySelector('thead tr');
  return header ? Array.from(header.children, (cell) => clean(cell.textContent)) : [];
}

/** The pay amount column (not the union commission). */
const payAmountColumn = (title: string): boolean => /金额/.test(title) && !/佣金/.test(title);
/** The applied amount column (not the paid-out net, fee or tax). */
const withdrawalAmountColumn = (title: string): boolean =>
  /金额/.test(title) && !/实付|实际|到账|手续费|税|净/.test(title);

it(
  '[AC-F1-07jb-LIST#1] 订单页签每行显示订单号、平台、付款金额列里的该单付款金额（后台格式、负数保留负号）、平台状态与返利状态的字典名（缺键显示编码）、北京时间付款时间；别的用户的订单不出现',
  async () => {
    await mount(SUPER);
    await openUser(UID);
    await tabRow();
    await openTab('订单');
    await rowShown(uidOrders()[0]!.sub_order_id);
    await settled();
    for (const order of uidOrders()) {
      const row = rowWith(order.sub_order_id);
      const text = clean(row.textContent);
      expect(text).toMatch(PLATFORM_SHOWN[order.platform]!);
      expect(clean(cellUnder(row, payAmountColumn, '付款金额').textContent)).toContain(
        yuan(order.pay_amount_fen!),
      );
      expect(text).toContain(dictName('platform_status', order.platform_status));
      expect(text).toContain(dictName('rebate_status', order.rebate_status));
      expect(squash(text)).toContain(squash(ORDER_PAID_AT[order.sub_order_id]));
    }
    for (const order of parentOrders()) expect(rowsWith(order.sub_order_id)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jb-LIST#2] 找回页签每行显示找回单号（claim_id）、状态的字典名（admin_dict.claim_status）与北京时间提交时间；别的用户的找回不出现',
  async () => {
    await mount(SUPER);
    await openUser(UID);
    await tabRow();
    await openTab('找回');
    await rowShown(uidClaims()[0]!.claim_id);
    await settled();
    for (const claim of uidClaims()) {
      const text = clean(rowWith(claim.claim_id).textContent);
      expect(text).toContain(dictName('claim_status', claim.status));
      expect(squash(text)).toContain(squash(CLAIM_SUBMITTED_AT[claim.claim_id]));
    }
    for (const claim of parentClaims()) expect(rowsWith(claim.claim_id)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jb-LIST#3] 提现页签每行显示提现单号（out_biz_no）、金额列里的申请金额（后台格式）、状态的字典名（admin_dict.withdrawal_status）、申请时间列里北京时间的 created_at（不是 reviewed_at；若有审核时间列则显示 reviewed_at）；别的用户的提现不出现',
  async () => {
    await mount(SUPER);
    await openUser(UID);
    await tabRow();
    await openTab('提现');
    await rowShown(uidWithdrawals()[0]!.out_biz_no);
    await settled();
    for (const item of uidWithdrawals()) {
      const row = rowWith(item.out_biz_no);
      const text = clean(row.textContent);
      expect(clean(cellUnder(row, withdrawalAmountColumn, '金额').textContent)).toContain(
        yuan(item.amount_fen),
      );
      expect(text).toContain(dictName('withdrawal_status', item.status));
      const applied = squash(cellUnder(row, appliedAtColumn, '申请时间').textContent);
      expect(applied, '申请时间 shows created_at').toContain(
        squash(WITHDRAWAL_CREATED_AT[item.out_biz_no]),
      );
      const reviewed = WITHDRAWAL_REVIEWED_AT[item.out_biz_no];
      if (reviewed !== undefined) {
        expect(applied, '申请时间 is not the review time').not.toContain(squash(reviewed));
        if (columnTitles(row).some(reviewedAtColumn))
          expect(
            squash(cellUnder(row, reviewedAtColumn, '审核时间').textContent),
            '审核时间 shows reviewed_at',
          ).toContain(squash(reviewed));
      }
    }
    for (const item of parentWithdrawals()) expect(rowsWith(item.out_biz_no)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jb-LIST#4] 订单页签第二行点进去打开该订单的详情（读 GET /admin/v1/orders/{order_id}）',
  async () => {
    const server = await mount(SUPER);
    await openUser(UID);
    await tabRow();
    await openTab('订单');
    const target = uidOrders()[1]!;
    await rowShown(target.sub_order_id);
    await settled();
    await openRow(rowWith(target.sub_order_id), target.sub_order_id);
    await waitFor(() =>
      expect(server.requests('GET', `${ORDERS}/${target.order_id}`).length).toBeGreaterThan(0),
    );
    for (const other of uidOrders().filter((order) => order.order_id !== target.order_id))
      expect(server.requests('GET', `${ORDERS}/${other.order_id}`)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jb-LIST#5] 提现页签第二行点进去打开该提现单的详情（读 GET /admin/v1/withdrawals/{withdrawal_id}）',
  async () => {
    const server = await mount(SUPER);
    await openUser(UID);
    await tabRow();
    await openTab('提现');
    const target = uidWithdrawals()[1]!;
    await rowShown(target.out_biz_no);
    await settled();
    await openRow(rowWith(target.out_biz_no), target.out_biz_no);
    await waitFor(() =>
      expect(
        server.requests('GET', `${WITHDRAWALS}/${target.withdrawal_id}`).length,
      ).toBeGreaterThan(0),
    );
    for (const other of uidWithdrawals().filter(
      (item) => item.withdrawal_id !== target.withdrawal_id,
    ))
      expect(server.requests('GET', `${WITHDRAWALS}/${other.withdrawal_id}`)).toEqual([]);
  },
  FLOW_TIMEOUT,
);
