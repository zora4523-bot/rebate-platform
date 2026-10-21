// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { amount, entry, mount, rowFor } from './ledger-helpers.ts';
import {
  invite,
  inviteHint,
  ledgerServer,
  ledgerNames,
  list,
  orderId,
  paid,
  posting,
  reply,
  referralHint,
  withdrawalId,
} from './ledger-fixtures.ts';

it('[AC-F1-04a-LINK#1] 订单流水点击经 nav.open 传 OrderDetail 和原始 order_id', async () => {
  const http = ledgerServer(() => reply(list([posting()])));
  mount(http.api);
  await screen.findByText(/6\.01/, { exact: false });
  await userEvent.setup().click(entry(/\+\s*[¥￥]\s*6\.01/));
  expect(http.navigation()).toHaveLength(1);
  expect(http.navigation()[0]!.params).toEqual({
    route: 'OrderDetail',
    params: { order_id: orderId },
  });
  expect(http.requests).toHaveLength(1);
});

it('[AC-F1-04a-LINK#2] 提现流水点击经 nav.open 传 WithdrawRecords 和 withdrawal_id', async () => {
  const http = ledgerServer(() => reply(list([paid])));
  mount(http.api);
  await screen.findByText(/98\.76/, { exact: false });
  await userEvent.setup().click(entry(/98\.76/));
  expect(http.navigation()).toHaveLength(1);
  expect(http.navigation()[0]!.params).toEqual({
    route: 'WithdrawRecords',
    params: { withdrawal_id: withdrawalId },
  });
});

it('[AC-F1-04a-LINK#3] masked 和 REWARD 即使带 link 也不可跳转，普通无 link 行也不可点', async () => {
  const http = ledgerServer(() =>
    reply(
      list([
        posting({
          ledger_type: 'REFERRAL_CREDIT',
          sub_type: 'INDIRECT',
          masked: true,
          amount_fen: 61,
        }),
        { ...invite, link_type: 'order', link_id: orderId },
        posting({ ledger_type: 'CLAWBACK', masked: true, amount_fen: -445 }),
        posting({
          ledger_type: 'ADMIN_ADJUST',
          sub_type: 'OTHER',
          amount_fen: 217,
          link_type: null,
          link_id: null,
        }),
      ]),
    ),
  );
  mount(http.api);
  await screen.findByText(inviteHint, { exact: false });
  // BR-TEXT-19：邀请人一方的 CLAWBACK 仍名为「订单扣回」，说明只显示「邀请好友订单」。
  const maskedClawback = rowFor(amount(/-\s*¥\s*4\.45/));
  expect(maskedClawback.textContent).toContain(ledgerNames.CLAWBACK);
  expect(maskedClawback.textContent).toContain(referralHint);
  const user = userEvent.setup();
  for (const pattern of [
    /\+\s*[¥￥]\s*0\.61/,
    /\+\s*[¥￥]\s*10\.01/,
    /\+\s*[¥￥]\s*2\.17/,
    /-\s*¥\s*4\.45/,
  ]) {
    expect(screen.queryByRole('link', { name: pattern })).toBeNull();
    expect(screen.queryByRole('button', { name: pattern })).toBeNull();
    await user.click(rowFor(amount(pattern)));
    await user.keyboard('{Enter} ');
  }
  expect(http.navigation()).toEqual([]);
  expect(document.body.textContent).not.toContain(orderId);
});

it('[AC-F1-04a-LINK#4] 分享收益按契约关联订单跳转，键盘也可激活', async () => {
  const http = ledgerServer(() => reply(list([posting({ ledger_type: 'SHARE_CREDIT' })])));
  mount(http.api);
  await screen.findByText(/6\.01/, { exact: false });
  entry(/\+\s*¥\s*6\.01/).focus();
  await userEvent.setup().keyboard('{Enter}');
  expect(http.navigation().map((request) => request.params)).toEqual([
    { route: 'OrderDetail', params: { order_id: orderId } },
  ]);
});

it('[AC-F1-04a-LINK#5] 人工调账按 link_type 区分订单与提现单，不根据流水名称猜跳转', async () => {
  const http = ledgerServer(() =>
    reply(
      list([
        posting({ ledger_type: 'ADMIN_ADJUST', sub_type: 'RESTORE', amount_fen: 120 }),
        posting({
          ledger_type: 'ADMIN_ADJUST',
          sub_type: 'PAYOUT_RECOVERY',
          amount_fen: -500,
          link_type: 'withdrawal',
          link_id: withdrawalId,
        }),
      ]),
    ),
  );
  mount(http.api);
  await screen.findByText(/1\.2/, { exact: false });
  const user = userEvent.setup();
  await user.click(entry(/\+\s*¥\s*1\.2/));
  await user.click(entry(/-\s*¥\s*5/));
  expect(http.navigation().map((request) => request.params)).toEqual([
    { route: 'OrderDetail', params: { order_id: orderId } },
    { route: 'WithdrawRecords', params: { withdrawal_id: withdrawalId } },
  ]);
});
