// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import {
  copy,
  defaultSummary,
  earningsServer,
  platformNames,
  reply,
  SECTIONS,
  summary,
  taobaoSummary,
} from './earnings-fixtures.ts';
import {
  columnValues,
  control,
  expectQuery,
  hasSection,
  LOADING,
  mount,
  pageText,
  ready,
  squash,
} from './earnings-helpers.ts';

const RETRY = /重试|重新加载/;

function expectNoFigures(): void {
  for (const title of SECTIONS) expect(hasSection(title), `不显示「${title}」栏`).toBe(false);
}

it('[AC-F1-12a-STATE#1] 请求在途显示加载态，返回后才显示三栏', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = earningsServer({ summary: () => pending.promise });
  const view = mount(http.api);
  await waitFor(() => expect(http.summaryRequests()).toHaveLength(1));
  expect(view.container.querySelector(LOADING)).not.toBeNull();
  expectNoFigures();
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => {
    pending.resolve(reply(summary));
  });
  await ready();
  expect(columnValues(copy.self).count).toEqual(['5']);
  expect(
    view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
  ).toBeNull();
});

it('[AC-F1-12a-STATE#2] 30701（看板关闭）显示字典 error.30701 的整页提示，不出三栏、不重试', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const http = earningsServer({ summary: () => reply(null, 30701, 404) });
  const view = mount(http.api);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(pageText(view.container)).toContain(squash(copy.closed));
  expect(pageText(view.container)).not.toContain(squash(copy.loadFailed));
  expectNoFigures();
  await act(async () => {});
  expect(http.summaryRequests()).toHaveLength(1);
});

it('[AC-F1-12a-STATE#3] 看板接口返回 10405 显示 error.10405，只请求一次、不自动重放', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const http = earningsServer({
    summary: () => reply({ min_supported_version: '9.9.9' }, 10405, 403),
  });
  const view = mount(http.api);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(pageText(view.container)).toContain(squash(copy.outdated));
  expectNoFigures();
  await act(async () => {});
  expect(http.summaryRequests()).toHaveLength(1);
});

it('[AC-F1-12a-STATE#4] 原生取 H5 令牌因 10405 失败：显示错误态，不发看板请求、不泄露原生错误', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const http = earningsServer({ tokenFailure: 10405 });
  const view = mount(http.api);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(pageText(view.container)).toMatch(
    new RegExp(`${squash(copy.loadFailed)}|${squash(copy.outdated)}`),
  );
  expect(pageText(view.container)).not.toContain('PRIVATE');
  expectNoFigures();
  expect(http.summaryRequests()).toEqual([]);
});

it('[AC-F1-12a-STATE#5] 其他错误显示 h5.load_failed，点重试只再请求一次同一地址', async () => {
  const http = earningsServer({
    summary: (url, count) => (count === 1 ? reply(null, 50001, 500) : defaultSummary(url)),
  });
  mount(http.api);
  expect((await screen.findByRole('alert')).textContent).toContain(copy.loadFailed);
  expectNoFigures();
  expect(http.summaryRequests()).toHaveLength(1);
  await userEvent.setup().click(screen.getByRole('button', { name: RETRY }));
  await ready();
  expect(http.summaryRequests()).toHaveLength(2);
  expect(http.summaryRequests()[1]!.url).toBe(http.summaryRequests()[0]!.url);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(columnValues(copy.self).count).toEqual(['5']);
});

it('[AC-F1-12a-STATE#6] 断网显示错误态与重试，不显示错误细节，恢复后重试成功', async () => {
  const http = earningsServer({
    summary: (url, count) =>
      count === 1 ? Promise.reject(new TypeError('Failed to fetch')) : defaultSummary(url),
  });
  mount(http.api);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent?.trim()).not.toBe('');
  expect(alert.textContent).not.toMatch(/TypeError|Failed to fetch/);
  await userEvent.setup().click(screen.getByRole('button', { name: RETRY }));
  await ready();
  expect(http.summaryRequests()).toHaveLength(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('[AC-F1-12a-STATE#7] 切平台后请求失败显示 h5.load_failed，重试仍带该平台', async () => {
  const http = earningsServer({
    summary: (url, count) => (count === 2 ? reply(null, 50001, 500) : defaultSummary(url)),
  });
  mount(http.api);
  await ready();
  const user = userEvent.setup();
  await user.click(control(platformNames.taobao));
  expect((await screen.findByRole('alert')).textContent).toContain(copy.loadFailed);
  expectQuery(http.summaryRequests()[1]!, 'taobao');
  await user.click(screen.getByRole('button', { name: RETRY }));
  await waitFor(() => expect(http.summaryRequests()).toHaveLength(3));
  expectQuery(http.summaryRequests()[2]!, 'taobao');
  await waitFor(() =>
    expect(columnValues(copy.self).count).toEqual([
      String(taobaoSummary.self.this_month.paid_count),
    ]),
  );
  expect(screen.queryByRole('alert')).toBeNull();
});
