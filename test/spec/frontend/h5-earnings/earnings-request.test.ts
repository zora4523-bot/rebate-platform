// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { EarningsPage } from '../../../../apps/h5/src/entries/app/pages/earnings/index.ts';
import { createAppRoutes } from '../../../../apps/h5/src/entries/app/routes.ts';
import {
  ALL,
  config,
  copy,
  defaultSummary,
  earningsServer,
  period,
  platformNames,
  reply,
  SUMMARY_PATH,
  taobaoSummary,
  type EarningsSummary,
} from './earnings-fixtures.ts';
import {
  columnValues,
  control,
  controls,
  exactName,
  expectQuery,
  isSelected,
  mount,
  pullDown,
  ready,
  section,
} from './earnings-helpers.ts';

it('[AC-F1-12a-REQ#1] Earnings 路由 /earnings 懒加载收益看板页面', async () => {
  const route = createAppRoutes().find((item) => item.path === '/earnings');
  expect(route).toBeDefined();
  expect((await route!.lazy()).Component).toBe(EarningsPage);
});

it('[AC-F1-12a-REQ#2] 进页经桥取一次 H5 令牌，只发一次不带参数的 GET /v1/earnings/summary，不签名', async () => {
  const http = earningsServer();
  mount(http.api);
  await ready();
  expect(http.summaryRequests()).toHaveLength(1);
  expectQuery(http.summaryRequests()[0]!);
  expect(http.summaryRequests()[0]!.headers.get('Authorization')).toBe('Bearer earnings-token-1');
  expect(http.tokenCalls()).toBe(1);
  // 配置只经桥 app.getConfig 读取；HTTP 上只有看板接口（不读 /v1/config，不走签名通道）。
  expect(http.requests.map((request) => new URL(request.url).pathname)).toEqual([SUMMARY_PATH]);
  expect(http.calls('net.signedRequest')).toEqual([]);
});

it('[AC-F1-12a-REQ#3] 四个期间来回切换只换显示，不重新请求也不重取令牌', async () => {
  const http = earningsServer();
  mount(http.api);
  await ready();
  const user = userEvent.setup();
  for (const key of ['today', 'yesterday', 'last_month', 'this_month'] as const) {
    await user.click(control(copy.period[key]));
    await act(async () => {});
    expect(isSelected(control(copy.period[key])), `${copy.period[key]} 选中`).toBe(true);
  }
  await user.click(control(copy.period.today));
  expect(columnValues(copy.self).count).toEqual(['1']);
  await act(async () => {});
  expect(http.summaryRequests()).toHaveLength(1);
  expect(http.tokenCalls()).toBe(1);
});

it('[AC-F1-12a-REQ#4] 选中平台胶囊带 platform 重新请求一次，之后切期间仍不请求', async () => {
  const http = earningsServer();
  mount(http.api);
  await ready();
  const user = userEvent.setup();
  await user.click(control(platformNames.taobao));
  await waitFor(() => expect(http.summaryRequests()).toHaveLength(2));
  expectQuery(http.summaryRequests()[1]!, 'taobao');
  expect(http.summaryRequests()[1]!.headers.get('Authorization')).toBe('Bearer earnings-token-1');
  await waitFor(() => expect(columnValues(copy.self).count).toEqual(['2']));
  for (const key of ['today', 'last_month', 'this_month'] as const) {
    await user.click(control(copy.period[key]));
  }
  await act(async () => {});
  expect(http.summaryRequests()).toHaveLength(2);
  // 回到「全部」：显示全部平台的数；若再请求，只能是不带 platform 的一次。
  await user.click(control(ALL));
  await waitFor(() => expect(columnValues(copy.self).count).toEqual(['5']));
  await act(async () => {});
  const after = http.summaryRequests().slice(2);
  expect(after.length).toBeLessThanOrEqual(1);
  for (const request of after) expectQuery(request);
});

it('[AC-F1-12a-REQ#5] 下拉刷新按当前平台重请求一次，在途不重复，期间选择保留', async () => {
  const pending = Promise.withResolvers<Response>();
  const refreshed: EarningsSummary = {
    ...taobaoSummary,
    self: { ...taobaoSummary.self, last_month: period(4, 4321, 0) },
  };
  const http = earningsServer({
    summary: (url, count) => (count === 3 ? pending.promise : defaultSummary(url)),
  });
  mount(http.api);
  await ready();
  const user = userEvent.setup();
  await user.click(control(platformNames.taobao));
  await waitFor(() => expect(columnValues(copy.self).count).toEqual(['2']));
  await user.click(control(copy.period.last_month));
  expect(columnValues(copy.self).est).toEqual(['¥4.44']);
  const target = section(copy.self);
  pullDown(target);
  pullDown(target);
  await waitFor(() => expect(http.summaryRequests()).toHaveLength(3));
  expectQuery(http.summaryRequests()[2]!, 'taobao');
  await act(async () => {
    pending.resolve(reply(refreshed));
  });
  await waitFor(() => expect(columnValues(copy.self).est).toEqual(['¥43.21']));
  expect(isSelected(control(copy.period.last_month))).toBe(true);
  expect(isSelected(control(platformNames.taobao))).toBe(true);
  await act(async () => {});
  expect(http.summaryRequests()).toHaveLength(3);
});

it('[AC-F1-12a-REQ#6] 平台胶囊为「全部」加 platform_status 中不是 not_launched 的平台，默认选中「全部」', async () => {
  const http = earningsServer({
    config: () => config({ taobao: 'on', jd: 'maintenance', pdd: 'not_launched' }),
  });
  mount(http.api);
  await ready();
  await waitFor(() => expect(controls(exactName(platformNames.taobao))).toHaveLength(1));
  expect(controls(exactName(platformNames.jd))).toHaveLength(1);
  expect(controls(exactName(platformNames.pdd))).toEqual([]);
  expect(isSelected(control(ALL))).toBe(true);
  expect(isSelected(control(platformNames.taobao))).toBe(false);
  expect(http.calls('app.getConfig').length).toBeGreaterThanOrEqual(1);
  await userEvent.setup().click(control(platformNames.jd));
  await waitFor(() => expect(http.summaryRequests()).toHaveLength(2));
  expectQuery(http.summaryRequests()[1]!, 'jd');
  expect(isSelected(control(platformNames.jd))).toBe(true);
  expect(isSelected(control(ALL))).toBe(false);
});

it('[AC-F1-12a-REQ#7] 三个平台都开放时显示三个平台胶囊', async () => {
  const http = earningsServer({
    config: () => config({ taobao: 'on', jd: 'on', pdd: 'on' }),
  });
  mount(http.api);
  await ready();
  await waitFor(() => expect(controls(exactName(platformNames.pdd))).toHaveLength(1));
  expect(controls(exactName(platformNames.taobao))).toHaveLength(1);
  expect(controls(exactName(platformNames.jd))).toHaveLength(1);
  expect(controls(exactName(ALL))).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
});
