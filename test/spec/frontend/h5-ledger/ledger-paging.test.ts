// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  endText,
  invite,
  inviteHint,
  ledgerServer,
  list,
  posting,
  reply,
} from './ledger-fixtures.ts';
import { LOADING, amount, expectQuery, mount, pullDown, reachBottom } from './ledger-helpers.ts';

it('[AC-F1-04a-PAGING#1] 滚到底携带原样游标追加下一页，在途不重复请求，到底不再请求', async () => {
  const cursor = 'next+/=流水';
  const pending = Promise.withResolvers<Response>();
  const http = ledgerServer((url) =>
    url.searchParams.has('cursor') ? pending.promise : reply(list([invite], cursor)),
  );
  const view = mount(http.api);
  await screen.findByText(inviteHint, { exact: false });
  expect(screen.queryByText(endText, { exact: false })).toBeNull();
  const target = amount(/\+\s*[¥￥]\s*10\.01/);
  reachBottom(target);
  reachBottom(target);
  await waitFor(() => expect(http.requests).toHaveLength(2));
  expect(view.container.querySelector(LOADING)).not.toBeNull();
  expectQuery(http.requests[0]!);
  expectQuery(http.requests[1]!, cursor);
  expect(http.requests[1]!.headers.get('Authorization')).toBe('Bearer ledger-token-1');
  await act(async () => {
    pending.resolve(reply(list([posting({ amount_fen: 321, accounting_date: '2026-09-30' })])));
  });
  await screen.findByText(/3\.21/, { exact: false });
  expect(amount(/\+\s*[¥￥]\s*10\.01/)).toBeTruthy();
  expect(screen.getByText(endText, { exact: false })).toBeTruthy();
  reachBottom(amount(/\+\s*[¥￥]\s*3\.21/));
  await act(async () => {});
  expect(http.requests).toHaveLength(2);
});

it('[AC-F1-04a-PAGING#2] 下拉刷新只重取第一页一次，丢弃旧页并使用新游标', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = ledgerServer((_url, count) => {
    if (count === 1) return reply(list([invite], 'old-cursor'));
    if (count === 2) return reply(list([posting({ amount_fen: 226 })]));
    if (count === 3) return pending.promise;
    return reply(list([posting({ amount_fen: 443 })]));
  });
  mount(http.api);
  await screen.findByText(inviteHint, { exact: false });
  const target = amount(/\+\s*[¥￥]\s*10\.01/);
  reachBottom(target);
  await screen.findByText(/2\.26/, { exact: false });
  expectQuery(http.requests[1]!, 'old-cursor');
  pullDown(target);
  pullDown(target);
  await waitFor(() => expect(http.requests).toHaveLength(3));
  expectQuery(http.requests[2]!);
  await act(async () => {
    pending.resolve(reply(list([posting({ amount_fen: 332 })], 'new-cursor')));
  });
  await screen.findByText(/3\.32/, { exact: false });
  await act(async () => {});
  // 在主动翻下一页之前核对：刷新只能新增一次首页请求，不能重取已加载的后续页。
  const refreshRequests = http.requests.slice(2);
  expect(refreshRequests).toHaveLength(1);
  expectQuery(refreshRequests[0]!);
  expect(screen.queryByText(inviteHint, { exact: false })).toBeNull();
  expect(screen.queryByText(/2\.26/, { exact: false })).toBeNull();
  expect(screen.queryByText(/4\.43/, { exact: false })).toBeNull();
  reachBottom(amount(/\+\s*[¥￥]\s*3\.32/));
  await screen.findByText(/4\.43/, { exact: false });
  expect(http.requests).toHaveLength(4);
  expectQuery(http.requests[3]!, 'new-cursor');
});
