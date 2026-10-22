// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  claims,
  fixture,
  ORDER_NO,
  PAID_DATE,
  result,
  texts,
  type SignedResult,
} from './find-order-fixtures.ts';
import {
  control,
  dateInput,
  expectLocated,
  fieldError,
  fill,
  isSelected,
  mount,
  orderInput,
  ready,
  submit,
  submitButton,
} from './find-order-helpers.ts';

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
afterEach(() => {
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});
function trackScroll() {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
}

it('[AC-F1-04b-SUBMIT#1] POST只经签名桥发送三个契约字段，保留长单号字符串且不注入用户身份', async () => {
  const view = mount(fixture({ signed: () => result(30201, null) }));
  await ready();
  await userEvent.setup().click(control('拼多多'));
  await fill('260918-098765432109876');
  await userEvent.setup().click(submitButton());
  await screen.findByText(texts['error.30201'], { exact: false });
  expect(view.signedRequests.map((request) => request.params)).toEqual([
    {
      method: 'POST',
      path: '/v1/orders/claims',
      body: { platform: 'pdd', order_no: '260918-098765432109876', paid_date: PAID_DATE },
    },
  ]);
  expect(view.http.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

it('[AC-F1-04b-SUBMIT#2] 提交未返回时禁用按钮，连续点击只发一个签名请求', async () => {
  const pending = Promise.withResolvers<SignedResult>();
  const view = mount(fixture({ signed: () => pending.promise }));
  await fill();
  await userEvent.setup().dblClick(submitButton());
  await waitFor(() => expect(view.signedRequests).toHaveLength(1));
  expect(submitButton().disabled).toBe(true);
  await userEvent.setup().click(submitButton());
  expect(view.signedRequests).toHaveLength(1);
  await act(async () => {
    pending.resolve(result(30201, null));
  });
  await screen.findByText(texts['error.30201'], { exact: false });
  expect(submitButton().disabled).toBe(false);
});

it('[AC-F1-04b-SUBMIT#3] 30201按字典放订单号下并建立aria关联', async () => {
  const view = await fieldError(30201, null, 'error.30201');
  expect(view.signedRequests).toHaveLength(1);
});
it('[AC-F1-04b-SUBMIT#4] 30202付款因子不符只关联付款日期', async () => {
  const view = await fieldError(
    30202,
    { reason: 'FACTOR_MISMATCH' },
    'error.30202.FACTOR_MISMATCH',
    'date',
  );
  expect(view.signedRequests).toHaveLength(1);
});
it('[AC-F1-04b-SUBMIT#5] 30202过期关联订单号并使用原因子键', async () => {
  const view = await fieldError(30202, { reason: 'CLAIM_EXPIRED' }, 'error.30202.CLAIM_EXPIRED');
  expect(view.signedRequests).toHaveLength(1);
});
it('[AC-F1-04b-SUBMIT#6] 30202失效关联订单号并使用原因子键', async () => {
  const view = await fieldError(30202, { reason: 'ORDER_INVALID' }, 'error.30202.ORDER_INVALID');
  expect(view.signedRequests).toHaveLength(1);
});
it('[AC-F1-04b-SUBMIT#7] 30202已属本人关联订单号并使用原因子键', async () => {
  const view = await fieldError(30202, { reason: 'ALREADY_YOURS' }, 'error.30202.ALREADY_YOURS');
  expect(view.signedRequests).toHaveLength(1);
});
it('[AC-F1-04b-SUBMIT#8] 30202无已知reason回退通用字典，不显示服务端内部msg', async () => {
  const view = await fieldError(30202, null, 'error.30202');
  expect(view.container.textContent).not.toContain('other-owner');
});
it('[AC-F1-04b-SUBMIT#9] 20001按data.fields在订单号旁提示校验失败', async () => {
  const view = await fieldError(20001, { fields: ['order_no'] }, 'error.20001');
  expect(view.signedRequests).toHaveLength(1);
});
it('[AC-F1-04b-SUBMIT#10] 20001付款日期字段错误不会错挂到订单号', async () => {
  const view = await fieldError(20001, { fields: ['paid_date'] }, 'error.20001', 'date');
  expect(view.signedRequests).toHaveLength(1);
});

async function blocked(code: number, data: unknown, key: keyof typeof texts) {
  const view = mount(fixture({ signed: () => result(code, data) }));
  await submit();
  await screen.findByText(texts[key], { exact: false });
  expect(submitButton().disabled).toBe(true);
  expect(view.container.textContent).not.toMatch(
    /(?:\d+|[一二三四五六七八九十]+)\s*次|RISK_BLOCKED|claim_fail_burst|PRIVATE/,
  );
  await userEvent.setup().click(control('京东'));
  await fill('9999999999999999999');
  expect(submitButton().disabled).toBe(true);
  await userEvent.setup().click(submitButton());
  expect(view.signedRequests).toHaveLength(1);
  return view;
}

it('[AC-F1-04b-SUBMIT#11] 30203当天禁止再次提交且不透露上限次数', async () => {
  const view = await blocked(30203, null, 'error.30203');
  expect(view.signedRequests).toHaveLength(1);
});
it('[AC-F1-04b-SUBMIT#12] 30203风控子码使用专用文案且切平台改输入也不能绕过禁用', async () => {
  const view = await blocked(30203, { reason: 'RISK_BLOCKED' }, 'error.30203.RISK_BLOCKED');
  expect(view.signedRequests).toHaveLength(1);
});
it('[AC-F1-04b-SUBMIT#13] 30206关闭后禁止提交且不显示具体次数', async () => {
  const view = await blocked(30206, null, 'error.30206');
  expect(view.signedRequests).toHaveLength(1);
});

it('[AC-F1-04b-SUBMIT#14] 30204只显示已被认领字典文案，不透露认领人', async () => {
  const view = await fieldError(30204, null, 'error.30204');
  expect(view.container.textContent).not.toMatch(/other-owner|PRIVATE/);
  expect(view.signedRequests).toHaveLength(1);
});

it('[AC-F1-04b-SUBMIT#15] 成功切记录页签并定位响应claim_id对应的新申请', async () => {
  trackScroll();
  const created = { ...claims[0]!, order_no: '9988776655443322110' };
  const view = mount(
    fixture({ signed: () => result(0, created), items: [claims[1]!, claims[2]!, created] }),
  );
  await fill(created.order_no);
  await userEvent.setup().click(submitButton());
  await expectLocated(created.order_no, '审核中');
  expect(
    view.http.requests.filter((request) => new URL(request.url).pathname === '/v1/orders/claims'),
  ).toHaveLength(1);
  expect(view.signedRequests).toHaveLength(1);
});

it('[AC-F1-04b-SUBMIT#16] 30205无额外data仍按平台单号定位已有申请并显示字典提示', async () => {
  trackScroll();
  const decoy = { ...claims[2]!, order_no: ORDER_NO };
  const view = mount(
    fixture({ signed: () => result(30205, null), items: [decoy, claims[1]!, claims[0]!] }),
  );
  await submit();
  await waitFor(() => {
    const inline = view.container.textContent?.includes(texts['error.30205']);
    const toasted = view.toastRequests.some(
      ({ params }) =>
        typeof params === 'object' &&
        params !== null &&
        'text' in params &&
        typeof params.text === 'string' &&
        params.text.includes(texts['error.30205']),
    );
    expect(inline || toasted).toBe(true);
  });
  // Same order_no on another platform must not become the selected claim.
  await waitFor(() => {
    const calls = vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts;
    const target = calls.find(
      (element) =>
        element instanceof HTMLElement &&
        element.textContent?.includes('审核中') &&
        element.textContent.includes(ORDER_NO) &&
        !element.textContent.includes('已找回'),
    );
    const focus = document.activeElement?.closest('[data-claim-id], article, li');
    expect(
      target !== undefined ||
        (focus?.textContent?.includes('审核中') && focus.textContent.includes(ORDER_NO)),
    ).toBeTruthy();
  });
  expect(isSelected(control('找回记录'))).toBe(true);
  expect(view.signedRequests).toHaveLength(1);
});

it('[AC-F1-04b-SUBMIT#17] 10405显示升级错误且绝不自动重放签名请求', async () => {
  const view = mount(fixture({ signed: () => result(10405, { min_supported_version: '9.9.9' }) }));
  await submit();
  await screen.findByText(texts['error.10405'], { exact: false });
  await act(async () => {
    view.native.emit({ event: 'app.resume', data: {} });
  });
  expect(view.signedRequests).toHaveLength(1);
  expect(orderInput().value).toBe(ORDER_NO);
  expect(dateInput().value).toBe(PAID_DATE);
});

it('[AC-F1-04b-SUBMIT#18] 网络失败保留平台与输入，不自动重发，用户可再次操作', async () => {
  const view = mount(fixture({ signed: () => Promise.reject(new Error('fixture offline')) }));
  await ready();
  await userEvent.setup().click(control('拼多多'));
  await submit();
  await screen.findByText(texts['buy.timeout'], { exact: false });
  expect(view.container.textContent).not.toContain(texts['error.30201']);
  expect(view.container.textContent).not.toContain(texts['error.30206']);
  expect(orderInput().value).toBe(ORDER_NO);
  expect(dateInput().value).toBe(PAID_DATE);
  expect(submitButton().disabled).toBe(false);
  expect(view.signedRequests).toHaveLength(1);
  expect(view.signedRequests[0]?.params).toMatchObject({ body: { platform: 'pdd' } });
});
