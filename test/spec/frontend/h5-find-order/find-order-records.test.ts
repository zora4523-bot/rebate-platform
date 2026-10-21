// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import {
  autoText,
  claims,
  emptyText,
  fixture,
  footerText,
  noEvidenceText,
  notInPoolText,
  pendingText,
  reply,
  texts,
} from './find-order-fixtures.ts';
import { control, mount, records, row } from './find-order-helpers.ts';

it('[AC-F1-04b-RECORDS#1] 找回记录通过带H5令牌的GET读取本人记录，按服务端顺序显示平台状态单号日期说明', async () => {
  const view = mount();
  await records();
  await screen.findByText(new RegExp(claims[3]!.order_no));
  const expectations = [
    ['淘宝', '审核中', pendingText],
    ['淘宝', '已自动跟单', autoText],
    ['京东', '已找回', '订单找回成功'],
    ['拼多多', '未通过', noEvidenceText],
  ];
  for (const [index, claim] of claims.entries()) {
    const [platform, status, explanation] = expectations[index]!;
    const item = row(claim.order_no, status!);
    expect(item.textContent).toContain(platform);
    expect(item.textContent).toContain(claim.paid_date.slice(5));
    expect(item.textContent).toContain(explanation);
    if (index > 0)
      expect(
        row(claims[index - 1]!.order_no, expectations[index - 1]![1]!).compareDocumentPosition(
          item,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
  }
  expect(view.container.textContent).toContain(footerText);
  expect(view.http.requests).toHaveLength(1);
  const request = view.http.requests[0]!;
  expect(request.method).toBe('GET');
  expect(new URL(request.url).pathname).toBe('/v1/orders/claims');
  expect(
    [...new URL(request.url).searchParams.keys()].every((key) => ['cursor', 'limit'].includes(key)),
  ).toBe(true);
  expect(request.headers.get('Authorization')).toBe('Bearer find-order-memory-token');
  expect(view.signedRequests).toHaveLength(0);
});

it('[AC-F1-04b-RECORDS#2] 混合决定按子订单分别展示，整体approved不能覆盖驳回或自动跟单子项', async () => {
  const mixed = {
    ...claims[2]!,
    items: [
      { sub_order_id: 'child-approved-11', decision: 'approved', reject_reason: null },
      { sub_order_id: 'child-rejected-22', decision: 'rejected', reject_reason: 'NO_EVIDENCE' },
      { sub_order_id: 'child-cancelled-33', decision: 'cancelled', reject_reason: null },
    ],
  } as const;
  const view = mount(fixture({ items: [{ ...mixed, items: [...mixed.items] }] }));
  await records();
  await screen.findByText(/child-rejected-22/);
  const approved = row('child-approved-11', '已找回');
  const rejected = row('child-rejected-22', noEvidenceText);
  const cancelled = row('child-cancelled-33', '已自动跟单');
  expect(approved).not.toBe(rejected);
  expect(rejected).not.toBe(cancelled);
  expect(within(approved).queryByText(noEvidenceText, { exact: false })).toBeNull();
  expect(rejected.textContent).not.toContain('child-approved-11');
  expect(cancelled.textContent).not.toContain('child-rejected-22');
  expect(view.container.textContent).not.toMatch(/NO_EVIDENCE|reject_reason|user_id/);
});

it('[AC-F1-04b-RECORDS#3] NOT_IN_POOL只说明平台已记录归属，不显示对方信息或后台原因码', async () => {
  const view = mount(
    fixture({
      items: [
        {
          ...claims[3]!,
          items: [
            { sub_order_id: 'closed-child-41', decision: 'rejected', reject_reason: 'NOT_IN_POOL' },
          ],
        },
      ],
    }),
  );
  await records();
  await screen.findByText(notInPoolText, { exact: false });
  expect(view.container.textContent).not.toMatch(
    /NOT_IN_POOL|user_id|认领人|认领方|归属用户|other-owner/,
  );
  expect(row(claims[3]!.order_no, '未通过').textContent).toContain(notInPoolText);
});

it('[AC-F1-04b-RECORDS#4] submitted和auto_matched仍为审核中，不误展示为已自动跟单或已找回', async () => {
  const view = mount(
    fixture({
      items: [
        { ...claims[0]!, status: 'submitted' },
        {
          ...claims[1]!,
          status: 'auto_matched',
          items: [{ sub_order_id: 'matched-pending-child', decision: null, reject_reason: null }],
        },
      ],
    }),
  );
  await records();
  await screen.findByText(new RegExp(claims[1]!.order_no));
  expect(row(claims[0]!.order_no, '审核中').textContent).toContain(pendingText);
  expect(row(claims[1]!.order_no, '审核中').textContent).toContain(pendingText);
  expect(view.container.textContent).not.toMatch(/已自动跟单|已找回|订单找回成功/);
});

it('[AC-F1-04b-RECORDS#5] 空记录显示定稿空态，保留申请页签且没有虚构记录或额外空态按钮', async () => {
  const view = mount(fixture({ items: [] }));
  await records();
  await screen.findByText(emptyText, { exact: false });
  expect(control('申请找回')).toBeTruthy();
  expect(view.container.textContent).not.toContain(claims[0]!.order_no);
  expect(screen.queryByRole('button', { name: /重新申请|去找回|立即找回|加载更多/ })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('[AC-F1-04b-RECORDS#6] 列表请求中显示加载态，成功后移除加载并显示记录', async () => {
  const pending = Promise.withResolvers<Response>();
  const view = mount(fixture({ list: () => pending.promise }));
  await records();
  await waitFor(() => expect(view.http.requests).toHaveLength(1));
  expect(
    view.container.querySelector(
      '[aria-busy="true"], [role="status"], [data-slot="skeleton-block"]',
    ),
  ).not.toBeNull();
  expect(screen.queryByText(emptyText, { exact: false })).toBeNull();
  await act(async () => {
    pending.resolve(reply({ items: claims, next_cursor: null }));
  });
  await screen.findByText(new RegExp(claims[0]!.order_no));
  expect(
    view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
  ).toBeNull();
});

it('[AC-F1-04b-RECORDS#7] 列表首屏失败使用H5加载失败页，手动重试仅增加一次请求', async () => {
  const view = mount(
    fixture({
      list: (_url, count) =>
        count === 1 ? reply(null, 50001, 500) : reply({ items: claims, next_cursor: null }),
    }),
  );
  await records();
  expect((await screen.findByRole('alert')).textContent).toContain(texts['h5.load_failed']);
  expect(view.http.requests).toHaveLength(1);
  expect(screen.queryByText(emptyText, { exact: false })).toBeNull();
  await userEvent.setup().click(control(/重试|重新加载/));
  await screen.findByText(new RegExp(claims[0]!.order_no));
  expect(view.http.requests).toHaveLength(2);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(view.signedRequests).toHaveLength(0);
});

it('[AC-F1-04b-RECORDS#8] 记录接口没有返利金额时不编造画板样例金额或显示未替换参数', async () => {
  const view = mount(fixture({ items: [claims[2]!] }));
  await records();
  await screen.findByText(/订单找回成功/);
  expect(view.container.textContent).not.toMatch(/¥|￥|4\.5|\{rebate\}|undefined|NaN/);
  expect(row(claims[2]!.order_no, '已找回').textContent).toContain('订单找回成功');
});

it('[AC-F1-04b-RECORDS#9] EXPIRED_CLICK与FRAUD缺用户文案时显示通用未通过说明，不泄露后台原因码', async () => {
  const view = mount(
    fixture({
      items: [
        {
          ...claims[3]!,
          items: [
            {
              sub_order_id: 'rejected-expired-51',
              decision: 'rejected',
              reject_reason: 'EXPIRED_CLICK',
            },
            { sub_order_id: 'rejected-fraud-52', decision: 'rejected', reject_reason: 'FRAUD' },
          ],
        },
      ],
    }),
  );
  await records();
  await screen.findByText(/rejected-fraud-52/);
  const expired = row('rejected-expired-51', '订单找回未通过');
  const fraud = row('rejected-fraud-52', '订单找回未通过');
  expect(expired).not.toBe(fraud);
  expect(expired.textContent).not.toContain('rejected-fraud-52');
  expect(fraud.textContent).not.toContain('rejected-expired-51');
  for (const [item, subOrder] of [
    [expired, 'rejected-expired-51'],
    [fraud, 'rejected-fraud-52'],
  ] as const) {
    // A status/title or child-order identifier alone is not a rejection explanation.
    const explanation = (item.textContent ?? '')
      .replace(subOrder, '')
      .replace(/订单找回未通过|未通过|子订单号|子订单/g, '')
      .replace(/[\s：:，,。.!！;；-]/g, '');
    expect(explanation).toMatch(/[\u3400-\u9fff]/);
    expect(explanation).not.toMatch(/null|undefined|EXPIRED_CLICK|FRAUD|\{[^}]*\}/i);
  }
  expect(view.container.textContent).not.toMatch(
    /EXPIRED_CLICK|FRAUD|claim_reject_reason|null|undefined/,
  );
  // §7 has no approved user-side explanation for these codes: do not substitute NO_EVIDENCE.
  expect(view.container.textContent).not.toContain(noEvidenceText);
});

it('[AC-F1-04b-RECORDS#10] 固定2026年时钟后付款日期与提交时间同年省略年份、跨年保留年份', async () => {
  const current = {
    ...claims[0]!,
    paid_date: '2026-10-02',
    created_at: '2026-10-04T10:15:00+08:00',
  };
  const previous = {
    ...claims[3]!,
    paid_date: '2025-12-29',
    created_at: '2025-12-30T10:15:00+08:00',
  };
  mount(fixture({ items: [current, previous] }));
  await records();
  await screen.findByText(new RegExp(previous.order_no));
  const currentText = row(current.order_no, pendingText).textContent;
  expect(currentText).toMatch(/付款日期\s*10-02/);
  expect(currentText).toMatch(/提交于\s*10-04/);
  expect(currentText).not.toMatch(/2026-10-(?:02|04)/);
  const previousText = row(previous.order_no, noEvidenceText).textContent;
  expect(previousText).toMatch(/付款日期\s*2025-12-29/);
  expect(previousText).toMatch(/提交于\s*2025-12-30/);
});
