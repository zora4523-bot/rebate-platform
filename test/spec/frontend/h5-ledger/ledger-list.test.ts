// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LedgerPage } from '../../../../apps/h5/src/entries/app/pages/ledger/index.ts';
import { createAppRoutes } from '../../../../apps/h5/src/entries/app/routes.ts';
import {
  adjustmentCopy,
  balanceTemplate,
  invite,
  inviteHint,
  inviteName,
  ledgerServer,
  ledgerNames,
  list,
  paid,
  posting,
  reply,
  referralHint,
  writeoffHint,
} from './ledger-fixtures.ts';
import { amount, expectQuery, mount, rowFor } from './ledger-helpers.ts';

it('[AC-F1-04a-LIST#1] Ledger 路由懒加载真实余额流水页面', async () => {
  const route = createAppRoutes().find((item) => item.path === '/ledger');
  expect(route).toBeDefined();
  expect((await route!.lazy()).Component).toBe(LedgerPage);
});

it('[AC-F1-04a-LIST#2] 应用级客户端取令牌后请求第一页，按会计月分组且不捏造订单尾号和时间', async () => {
  const http = ledgerServer(() =>
    reply(list([posting(), { ...invite, accounting_date: '2026-09-30' }])),
  );
  const view = mount(http.api);
  await screen.findByText(inviteHint, { exact: false });
  const october = screen.getByText(/2026\s*年\s*10\s*月/);
  const september = screen.getByText(/2026\s*年\s*9\s*月/);
  expect(
    october.compareDocumentPosition(amount(/\+\s*[¥￥]\s*6\.01/)) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(
    amount(/\+\s*[¥￥]\s*6\.01/).compareDocumentPosition(september) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(
    september.compareDocumentPosition(amount(/\+\s*[¥￥]\s*10\.01/)) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  const octoberRow = rowFor(amount(/\+\s*[¥￥]\s*6\.01/));
  const septemberRow = rowFor(amount(/\+\s*[¥￥]\s*10\.01/));
  expect(octoberRow.textContent).toContain('10-12');
  expect(octoberRow.textContent).not.toContain('2026-10-12');
  expect(septemberRow.textContent).toContain('09-30');
  expect(septemberRow.textContent).not.toContain('2026-09-30');
  expect(view.container.textContent).not.toMatch(/订单尾号|今天|昨天|\d{2}:\d{2}|3790\*{4}88/);
  expect(http.requests).toHaveLength(1);
  expectQuery(http.requests[0]!);
  expect(http.tokenCalls()).toBe(1);
  expect(http.requests[0]!.headers.get('Authorization')).toBe('Bearer ledger-token-1');
});

it('[AC-F1-04a-LIST#3] 邀请奖励名称与说明取契约字典，正金额和负的变动后余额均保留符号', async () => {
  const http = ledgerServer(() => reply(list([invite])));
  mount(http.api);
  await screen.findByText(inviteHint, { exact: false });
  expect(screen.getByText(inviteName, { exact: false })).toBeTruthy();
  const row = rowFor(amount(/\+\s*[¥￥]\s*10\.01/));
  expect(row.textContent).toContain(inviteName);
  expect(row.textContent).toContain(inviteHint);
  expect(row.textContent).toContain('10-11');
  const normalized = row.textContent!.replace(/\s+/g, '');
  expect(normalized).toContain(balanceTemplate.replace('{amount}', '-¥5.67').replace(/\s+/g, ''));
  expect(http.requests).toHaveLength(1);
});

it('[AC-F1-04a-LIST#4] 扣回和正负补差按接口金额显示符号，不以流水类型猜测正负', async () => {
  const http = ledgerServer(() =>
    reply(
      list([
        posting({ ledger_type: 'CLAWBACK', sub_type: 'PART_REFUND', amount_fen: -401 }),
        posting({ ledger_type: 'SETTLE_ADJUST', sub_type: 'SETTLE_DIFF', amount_fen: 123 }),
        posting({ ledger_type: 'SETTLE_ADJUST', sub_type: 'PRICE_PROTECT', amount_fen: -234 }),
        invite,
      ]),
    ),
  );
  mount(http.api);
  await screen.findByText(inviteHint, { exact: false });
  expect(amount(/-\s*¥\s*4\.01/)).toBeTruthy();
  expect(amount(/\+\s*[¥￥]\s*1\.23/)).toBeTruthy();
  expect(amount(/-\s*¥\s*2\.34/)).toBeTruthy();
});

it('[AC-F1-04a-LIST#5] 注销放弃余额 ACCOUNT_CLOSED 对用户不可见', async () => {
  const http = ledgerServer(() =>
    reply(
      list([
        posting({
          ledger_type: 'ADMIN_ADJUST',
          sub_type: 'ACCOUNT_CLOSED',
          amount_fen: -9871,
          accounting_date: '2025-01-02',
          balance_after_fen: 0,
        }),
        invite,
      ]),
    ),
  );
  const view = mount(http.api);
  await screen.findByText(inviteHint, { exact: false });
  expect(view.container.textContent).not.toMatch(/98\.71|2025|ACCOUNT_CLOSED/);
  expect(view.container.textContent).toContain(inviteName);
});

it('[AC-F1-04a-LIST#6] 提现汇总无正负号，手续费与个税标签对应金额，仅汇总行不显示余额', async () => {
  const http = ledgerServer(() => reply(list([posting(), paid])));
  const view = mount(http.api);
  await screen.findByText(/0\.23/, { exact: false });
  const row = rowFor(amount(/[¥￥]\s*98\.76/));
  expect(row.textContent).toContain(ledgerNames.WITHDRAW_PAID);
  // BR-TEXT-19 WITHDRAW_PAID 的符号为 0，不影响可用余额；负的接口金额也不显示 +/-。
  expect(row.textContent?.replace(/\s+/g, '').match(/[+−-]?[¥￥][\d,]+(?:\.\d+)?/g)).toContain(
    '¥98.76',
  );
  // 明细可在可点行旁边或平铺于同一列表项；标签与金额仍须配对，互换必须失败。
  const listItem = row.closest('li, [role="listitem"]');
  expect(listItem).not.toBeNull();
  const details = listItem?.textContent?.replace(/\s+/g, '');
  expect(details).toContain(`${ledgerNames.TAX_WITHHOLD}¥1.01`);
  expect(details).toContain('手续费¥0.23');
  expect(details).not.toContain(`${ledgerNames.TAX_WITHHOLD}¥0.23`);
  expect(details).not.toContain('手续费¥1.01');
  expect(view.container.textContent).not.toMatch(/已转入|支付宝|银行卡/);
  expect(row.textContent).not.toContain(balanceTemplate.split('{amount}')[0]!.trim());
  expect(rowFor(amount(/\+\s*¥\s*6\.01/)).textContent).toContain(
    balanceTemplate.replace('{amount}', '¥12.34'),
  );
  expect(view.container.textContent).not.toMatch(/null|undefined|NaN/);
  expect(http.requests).toHaveLength(1);
});

it('[AC-F1-04a-A11Y#1] 可点流水行的可访问名包含名称、正负金额与会计日期', async () => {
  const http = ledgerServer(() => reply(list([posting()])));
  mount(http.api);
  await screen.findByText(/\+\s*[¥￥]\s*6\.01/, { exact: false });
  const row = rowFor(amount(/\+\s*[¥￥]\s*6\.01/));
  const controls = [
    ...screen.queryAllByRole('link', {
      name: new RegExp(`(?=.*${ledgerNames.REBATE_CREDIT})(?=.*\\+\\s*¥\\s*6\\.01)(?=.*10-12)`),
    }),
    ...screen.queryAllByRole('button', {
      name: new RegExp(`(?=.*${ledgerNames.REBATE_CREDIT})(?=.*\\+\\s*¥\\s*6\\.01)(?=.*10-12)`),
    }),
  ];
  expect(controls).toHaveLength(1);
  expect(row.contains(controls[0]!) || controls[0]!.contains(row)).toBe(true);
});

it('[AC-F1-04a-A11Y#2] 不可点奖励行也有含字典名称、正金额和日期的可访问名', async () => {
  const http = ledgerServer(() => reply(list([invite])));
  mount(http.api);
  await screen.findByText(inviteHint, { exact: false });
  const name = new RegExp(`(?=.*${inviteName})(?=.*\\+\\s*[¥￥]\\s*10\\.01)(?=.*10-11)`);
  const rows = ['listitem', 'row', 'group'].flatMap((role) =>
    screen.queryAllByRole(role, { name }),
  );
  expect(rows.length).toBeGreaterThan(0);
});

it('[AC-F1-04a-LIST#7] 自购、分享、扣回、部分退款、补差和提现名称按 BR-TEXT-19', async () => {
  // 以下名称由 ledger-fixtures 中逐字摘录的 BR-TEXT-19 表提供，不从页面实现取期望值。
  const cases = [
    { entry: posting({ amount_fen: 111 }), name: ledgerNames.REBATE_CREDIT, amount: '+¥1.11' },
    {
      entry: posting({ ledger_type: 'SHARE_CREDIT', amount_fen: 222 }),
      name: ledgerNames.SHARE_CREDIT,
      amount: '+¥2.22',
    },
    {
      entry: posting({ ledger_type: 'CLAWBACK', amount_fen: -333 }),
      name: ledgerNames.CLAWBACK,
      amount: '-¥3.33',
    },
    {
      entry: posting({ ledger_type: 'CLAWBACK', sub_type: 'PART_REFUND', amount_fen: -444 }),
      name: ledgerNames.PART_REFUND,
      amount: '-¥4.44',
    },
    {
      entry: posting({ ledger_type: 'SETTLE_ADJUST', sub_type: 'PRICE_COMPARE', amount_fen: -555 }),
      name: ledgerNames.SETTLE_ADJUST,
      amount: '-¥5.55',
    },
    {
      entry: posting({ ledger_type: 'WITHDRAW_FREEZE', amount_fen: -666, link_type: 'withdrawal' }),
      name: ledgerNames.WITHDRAW_FREEZE,
      amount: '-¥6.66',
    },
    {
      entry: posting({ ledger_type: 'WITHDRAW_RETURN', amount_fen: 777, link_type: 'withdrawal' }),
      name: ledgerNames.WITHDRAW_RETURN,
      amount: '+¥7.77',
    },
  ];
  mount(ledgerServer(() => reply(list(cases.map((item) => item.entry)))).api);
  await screen.findByText(ledgerNames.REBATE_CREDIT, { exact: false });
  for (const item of cases) {
    const row = rowFor(screen.getByText(item.name, { exact: false }));
    expect(row.textContent).toContain(item.name);
    expect(row.textContent?.replace(/\s+/g, '').match(/[+−-]?[¥￥][\d,]+(?:\.\d+)?/g)).toContain(
      item.amount,
    );
    expect(row.textContent).toContain(balanceTemplate.replace('{amount}', '¥12.34'));
  }
});

it('[AC-F1-04a-LIST#8] 直推与间推各用 BR-TEXT-19 名称并显示邀请好友订单及变动后余额', async () => {
  const http = ledgerServer(() =>
    reply(
      list([
        posting({
          ledger_type: 'REFERRAL_CREDIT',
          sub_type: 'DIRECT',
          masked: true,
          amount_fen: 150,
          balance_after_fen: 634,
        }),
        posting({
          ledger_type: 'REFERRAL_CREDIT',
          sub_type: 'INDIRECT',
          masked: true,
          amount_fen: 61,
          balance_after_fen: -150,
        }),
      ]),
    ),
  );
  const view = mount(http.api);
  await screen.findByText(ledgerNames.INDIRECT, { exact: false });
  const direct = rowFor(screen.getByText(ledgerNames.REFERRAL_CREDIT, { exact: false }));
  const indirect = rowFor(screen.getByText(ledgerNames.INDIRECT, { exact: false }));
  expect(direct.textContent).toContain(referralHint);
  expect(indirect.textContent).toContain(referralHint);
  expect(direct.textContent).toContain(balanceTemplate.replace('{amount}', '¥6.34'));
  expect(indirect.textContent).toContain(balanceTemplate.replace('{amount}', '-¥1.5'));
  expect(view.container.textContent).not.toMatch(/二级|间推|DIRECT|INDIRECT|\d{2}:\d{2}/);
});

it('[AC-F1-04a-LIST#9] ADMIN_ADJUST 四个可见原因码逐行匹配 BR-TEXT-19 名称与说明', async () => {
  const cases = Object.entries(adjustmentCopy);
  const http = ledgerServer(() =>
    reply(
      list(
        cases.map(([sub_type], index) =>
          posting({
            ledger_type: 'ADMIN_ADJUST',
            sub_type,
            amount_fen: index % 2 === 0 ? 120 : -120,
            accounting_date: `2026-10-${16 - index}`,
            link_type: null,
            link_id: null,
          }),
        ),
      ),
    ),
  );
  const view = mount(http.api);
  await screen.findByText(adjustmentCopy.RESTORE[0], { exact: false });
  for (const [code, [name, hint]] of cases) {
    const row = rowFor(screen.getByText(name, { exact: false }));
    expect(row.textContent).toContain(hint);
    expect(view.container.textContent).not.toContain(code);
  }
});

it('[AC-F1-04a-LIST#10] 负余额核销显示规格占位说明与零余额', async () => {
  const http = ledgerServer(() =>
    reply(
      list([
        posting({
          ledger_type: 'BAD_DEBT_WRITEOFF',
          amount_fen: 567,
          balance_after_fen: 0,
          link_type: null,
          link_id: null,
        }),
      ]),
    ),
  );
  mount(http.api);
  await screen.findByText(writeoffHint, { exact: false });
  const row = rowFor(screen.getByText(ledgerNames.BAD_DEBT_WRITEOFF, { exact: false }));
  expect(row.textContent).toContain(writeoffHint);
  expect(row.textContent?.replace(/\s+/g, '').match(/[+−-]?[¥￥][\d,]+(?:\.\d+)?/g)).toEqual([
    '+¥5.67',
    '¥0',
  ]);
});

it('[AC-F1-04a-LIST#11] App 金额去尾零且不加千分位，ASCII 负号在人民币符号之前', async () => {
  // 手算 BR-TEXT-10 向量；不调用实现使用的格式化函数作为测试期望值。
  const cases = [
    { fen: 600, text: '+¥6', date: '2026-10-10' },
    { fen: 990, text: '+¥9.9', date: '2026-10-09' },
    { fen: 1, text: '+¥0.01', date: '2026-10-08' },
    { fen: 123456, text: '+¥1234.56', date: '2026-10-07' },
    { fen: -150, text: '-¥1.5', date: '2026-10-06' },
  ];
  mount(
    ledgerServer(() =>
      reply(
        list(
          cases.map((item) =>
            posting({
              ledger_type: 'SETTLE_ADJUST',
              sub_type: 'SETTLE_DIFF',
              amount_fen: item.fen,
              accounting_date: item.date,
              balance_after_fen: item.fen,
            }),
          ),
        ),
      ),
    ).api,
  );
  await screen.findByText(/10-10/, { exact: false });
  for (const item of cases) {
    const row = rowFor(screen.getByText(item.date.slice(5), { exact: false }));
    const money = row.textContent?.replace(/\s+/g, '').match(/[+−-]?[¥￥][\d,]+(?:\.\d+)?/g);
    expect(money).toEqual([item.text, item.text.replace(/^\+/, '')]);
  }
});

it('[AC-F1-04a-LIST#12] 跨年会计日显示完整年月日且不伪造时分', async () => {
  mount(ledgerServer(() => reply(list([posting({ accounting_date: '2025-12-31' })]))).api);
  await screen.findByText(/2025-12-31/, { exact: false });
  const row = rowFor(amount(/\+\s*¥\s*6\.01/));
  expect(row.textContent).toContain('2025-12-31');
  expect(row.textContent).not.toMatch(/今天|昨天|\d{2}:\d{2}/);
});

it('[AC-F1-04a-A11Y#3] 出账流水的可访问名保留名称、负号与日期', async () => {
  mount(
    ledgerServer(() =>
      reply(
        list([
          posting({
            ledger_type: 'CLAWBACK',
            amount_fen: -150,
          }),
        ]),
      ),
    ).api,
  );
  await screen.findByText(ledgerNames.CLAWBACK, { exact: false });
  const name = new RegExp(`(?=.*${ledgerNames.CLAWBACK})(?=.*-\\s*¥\\s*1\\.5)(?=.*10-12)`);
  const controls = [
    ...screen.queryAllByRole('button', { name }),
    ...screen.queryAllByRole('link', { name }),
  ];
  expect(controls).toHaveLength(1);
});
