// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { config, fixture, guideTarget, result, texts } from './find-order-fixtures.ts';
import {
  control,
  dateInput,
  fill,
  isSelected,
  mount,
  orderInput,
  ready,
  submitButton,
} from './find-order-helpers.ts';

it('[AC-F1-04b-FORM#1] 进页取得令牌和配置，三平台切换同时更新字典填写指引', async () => {
  const view = mount();
  await ready();
  expect(isSelected(control('淘宝'))).toBe(true);
  for (const name of ['淘宝', '京东', '拼多多']) {
    await userEvent.setup().click(control(name));
    expect(view.container.textContent).toContain(
      texts['claim.guide.order_no'].replace('{platform_name}', name),
    );
    expect(isSelected(control(name))).toBe(true);
    expect(view.container.textContent).toContain(texts['claim.guide.paid_date']);
  }
  await waitFor(() =>
    expect(
      view.native.postMessage.mock.calls.some(([request]) => request.method === 'auth.getH5Token'),
    ).toBe(true),
  );
  expect(view.configRequests.length).toBeGreaterThan(0);
  expect(view.signedRequests).toHaveLength(0);
});

it('[AC-F1-04b-FORM#2] 期限句取配置的17天且显示核对提示，不采用画板样例30天', async () => {
  const view = mount();
  await ready();
  expect(view.container.textContent).toContain(
    texts['claim.guide.window'].replace('{claim_window_days}', '17'),
  );
  expect(view.container.textContent).toContain(texts['claim.guide.caution']);
  expect(view.container.textContent).not.toMatch(/30\s*天/);
});

it('[AC-F1-04b-FORM#3] 另一配置期限43天同样原样展示', async () => {
  const view = mount(fixture({ config: { ...config, claim: { window_days: 43 } } }));
  await ready();
  expect(view.container.textContent).toContain(
    texts['claim.guide.window'].replace('{claim_window_days}', '43'),
  );
  expect(view.container.textContent).not.toMatch(/17\s*天|30\s*天/);
});

it('[AC-F1-04b-FORM#4] window_days为null整句隐藏，不猜默认天数', async () => {
  const view = mount(fixture({ config: { ...config, claim: { window_days: null } } }));
  await ready();
  expect(view.container.textContent).not.toMatch(/付款后.*天内|(?:null|undefined|NaN).*天/);
  expect(submitButton()).toBeTruthy();
});

it('[AC-F1-04b-FORM#5] 有指引配置时通过桥打开Help及原样article_id，未配置平台隐藏入口', async () => {
  const view = mount();
  await ready();
  await userEvent.setup().click(control(texts['claim.guide.entry']));
  await waitFor(() =>
    expect(
      view.native.postMessage.mock.calls
        .filter(([request]) => request.method === 'nav.open')
        .map(([request]) => request.params),
    ).toEqual([guideTarget]),
  );
  await userEvent.setup().click(control('京东'));
  expect(screen.queryByText(texts['claim.guide.entry'], { exact: false })).toBeNull();
  await userEvent.setup().click(control('拼多多'));
  await userEvent.setup().click(control(texts['claim.guide.entry']));
  expect(
    view.native.postMessage.mock.calls
      .filter(([request]) => request.method === 'nav.open')
      .at(-1)?.[0].params,
  ).toEqual(config.help_links['claim_guide.pdd']);
  expect(view.signedRequests).toHaveLength(0);
});

it('[AC-F1-04b-FORM#6] 两字段为空时本地必填校验，不提交请求', async () => {
  const view = mount();
  await ready();
  await userEvent.setup().click(submitButton());
  expect(view.signedRequests).toHaveLength(0);
  expect(orderInput().value).toBe('');
  expect(dateInput().value).toBe('');
  expect(orderInput().required || orderInput().getAttribute('aria-invalid') === 'true').toBe(true);
  expect(dateInput().required || dateInput().getAttribute('aria-invalid') === 'true').toBe(true);
});

it('[AC-F1-04b-FORM#7] 全空格订单号按空值本地拦截并关联提示', async () => {
  const view = mount();
  await fill('   ');
  await userEvent.setup().click(submitButton());
  expect(view.signedRequests).toHaveLength(0);
  expect(orderInput().getAttribute('aria-invalid')).toBe('true');
  const linkedErrors =
    `${orderInput().getAttribute('aria-describedby') ?? ''} ${orderInput().getAttribute('aria-errormessage') ?? ''}`
      .split(/\s+/)
      .map((id) => document.getElementById(id));
  const errors = [...screen.queryAllByRole('alert'), ...linkedErrors]
    .map((element) => element?.textContent ?? '')
    .map((text) =>
      text
        .replace(texts['claim.guide.order_no'].replace('{platform_name}', '淘宝'), '')
        .replace(texts['claim.guide.paid_date'], ''),
    );
  expect(errors.some((text) => /填写|请输入|必填|不能为空/.test(text))).toBe(true);
});

it('[AC-F1-04b-FORM#8] 有订单号但缺付款日期时不提交，日期使用日期选择控件', async () => {
  const view = mount();
  await fill('3712345678901234567', '');
  await userEvent.setup().click(submitButton());
  expect(view.signedRequests).toHaveLength(0);
  expect(dateInput().type).toBe('date');
  expect(dateInput().required || dateInput().getAttribute('aria-invalid') === 'true').toBe(true);
});

it('[AC-F1-04b-FORM#9] 配置未到显示加载态，返回后进入表单', async () => {
  const pending = Promise.withResolvers<{ values: typeof config }>();
  const view = mount(fixture({ loadConfig: () => pending.promise }));
  await waitFor(() => expect(view.configRequests).toHaveLength(1));
  expect(
    view.container.querySelector(
      '[aria-busy="true"], [role="status"], [data-slot="skeleton-block"]',
    ),
  ).not.toBeNull();
  expect(view.signedRequests).toHaveLength(0);
  await act(async () => {
    pending.resolve({ values: config });
  });
  await ready();
  expect(
    view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
  ).toBeNull();
});

it('[AC-F1-04b-FORM#10] 首屏配置失败显示加载失败页，手动重试只再请求一次', async () => {
  let attempts = 0;
  const view = mount(
    fixture({
      loadConfig: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('fixture config offline');
        return { values: config };
      },
    }),
  );
  expect((await screen.findByRole('alert')).textContent).toContain(texts['h5.load_failed']);
  expect(view.configRequests).toHaveLength(1);
  await userEvent.setup().click(control(/重试|重新加载/));
  await ready();
  expect(view.configRequests).toHaveLength(2);
  expect(view.signedRequests).toHaveLength(0);
});

it('[AC-F1-04b-FORM#11] 进页取H5令牌失败显示错误态，不自动重放或提交', async () => {
  const view = mount(fixture({ tokenError: { code: 90500 } }));
  expect((await screen.findByRole('alert')).textContent).toContain(texts['h5.load_failed']);
  await act(async () => {
    view.native.emit({ event: 'app.resume', data: {} });
  });
  expect(view.tokenRequests).toHaveLength(1);
  expect(view.signedRequests).toHaveLength(0);
  expect(view.http.requests).toHaveLength(0);
  expect(view.container.textContent).not.toContain('PRIVATE');
});

it('[AC-F1-04b-FORM#12] 原生取H5令牌因10405失败时页面显示错误态，恢复前台不自动重放', async () => {
  const view = mount(
    fixture({ tokenError: { code: 10405, data: { min_supported_version: '9.9.9' } } }),
  );
  expect((await screen.findByRole('alert')).textContent).toContain(texts['h5.load_failed']);
  await act(async () => {
    view.native.emit({ event: 'app.resume', data: {} });
  });
  expect(view.tokenRequests).toHaveLength(1);
  expect(view.signedRequests).toHaveLength(0);
  expect(view.http.requests).toHaveLength(0);
  expect(view.container.textContent).not.toContain('PRIVATE');
});

it('[AC-F1-04b-FORM#13] 平台未开放时不显示其胶囊，其他开放平台仍可选择', async () => {
  const view = mount(
    fixture({
      signed: () => result(30201, null),
      config: {
        ...config,
        features: {
          ...config.features,
          platform_status: { taobao: 'not_launched', jd: 'on', pdd: 'on' },
        },
      },
    }),
  );
  await ready();
  for (const role of ['button', 'radio', 'tab'])
    expect(screen.queryByRole(role, { name: '淘宝' })).toBeNull();
  const selected = ['京东', '拼多多'].filter((name) => isSelected(control(name)));
  expect(selected).toHaveLength(1);
  await fill();
  await userEvent.setup().click(submitButton());
  await screen.findByText(texts['error.30201'], { exact: false });
  expect(view.signedRequests).toHaveLength(1);
  expect(view.signedRequests[0]!.params).toMatchObject({
    body: { platform: selected[0] === '京东' ? 'jd' : 'pdd' },
  });
  for (const name of ['京东', '拼多多']) {
    await userEvent.setup().click(control(name));
    expect(isSelected(control(name))).toBe(true);
    expect(
      screen.getByText(texts['claim.guide.order_no'].replace('{platform_name}', name), {
        exact: false,
      }),
    ).toBeTruthy();
  }
});

it('[AC-F1-04b-FORM#14] 维护中的首个平台不显示，默认选中开放平台并以该平台提交', async () => {
  const view = mount(
    fixture({
      signed: () => result(30201, null),
      config: {
        ...config,
        features: {
          ...config.features,
          platform_status: { taobao: 'maintenance', jd: 'on', pdd: 'on' },
        },
      },
    }),
  );
  await ready();
  for (const role of ['button', 'radio', 'tab'])
    expect(screen.queryByRole(role, { name: '淘宝' })).toBeNull();
  const selected = ['京东', '拼多多'].filter((name) => isSelected(control(name)));
  expect(selected).toHaveLength(1);
  await fill();
  await userEvent.setup().click(submitButton());
  await screen.findByText(texts['error.30201'], { exact: false });
  expect(view.signedRequests).toHaveLength(1);
  expect(view.signedRequests[0]!.params).toMatchObject({
    body: { platform: selected[0] === '京东' ? 'jd' : 'pdd' },
  });
  for (const name of ['京东', '拼多多']) {
    await userEvent.setup().click(control(name));
    expect(isSelected(control(name))).toBe(true);
    expect(view.container.textContent).toContain(
      texts['claim.guide.order_no'].replace('{platform_name}', name),
    );
  }
});
