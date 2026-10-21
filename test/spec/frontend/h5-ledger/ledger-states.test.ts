// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };
import {
  emptyHint,
  emptyTitle,
  invite,
  inviteHint,
  ledgerServer,
  list,
  reply,
} from './ledger-fixtures.ts';
import { LOADING, mount } from './ledger-helpers.ts';

it('[AC-F1-04a-STATES#1] 首屏请求在途显示加载态，完成后才显示流水', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = ledgerServer(() => pending.promise);
  const view = mount(http.api);
  await waitFor(() => expect(http.requests).toHaveLength(1));
  expect(view.container.querySelector(LOADING)).not.toBeNull();
  expect(screen.queryByText(emptyTitle, { exact: false })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => {
    pending.resolve(reply(list([invite])));
  });
  await screen.findByText(inviteHint, { exact: false });
  expect(
    view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
  ).toBeNull();
});

it('[AC-F1-04a-STATES#2] 空列表显示画板空态两句且不出现错误态', async () => {
  const http = ledgerServer(() => reply(list([])));
  mount(http.api);
  expect(await screen.findByText(emptyTitle, { exact: false })).toBeTruthy();
  expect(screen.getByText(emptyHint, { exact: false })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(http.requests).toHaveLength(1);
});

it('[AC-F1-04a-STATES#3] 首屏失败使用现有 H5 失败文案，点击重试只再请求一次', async () => {
  const http = ledgerServer((_url, count) =>
    count === 1 ? reply(null, 50001, 500) : reply(list([invite])),
  );
  mount(http.api);
  expect((await screen.findByRole('alert')).textContent).toContain(
    dictionary.texts['h5.load_failed'],
  );
  expect(http.requests).toHaveLength(1);
  await userEvent.setup().click(screen.getByRole('button', { name: /重试|重新加载/ }));
  await screen.findByText(inviteHint, { exact: false });
  expect(http.requests).toHaveLength(2);
  expect(http.requests[1]!.url).toBe(http.requests[0]!.url);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('[AC-F1-04a-STATES#4] 10405 显示错误态且请求只发一次，不自动重放', async () => {
  // 本轮编排裁定：10405 的 retry=never；10002 的一次令牌重放不适用于它。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const http = ledgerServer(() => reply(null, 10405, 403));
  mount(http.api);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toMatch(
    new RegExp(`${dictionary.texts['h5.load_failed']}|${dictionary.texts['error.10405']}`),
  );
  await act(async () => {});
  expect(http.requests).toHaveLength(1);
  expect(screen.queryByText(emptyTitle, { exact: false })).toBeNull();
});
