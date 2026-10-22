import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../shared/query.ts';
import { ClaimRecords } from './claim-records.tsx';
import { LOCATE_MAX_PAGES, type Claim, type LocateTarget } from './model.ts';

// 单元测试：API 客户端是内存假实现（不联网、不 listen）。

const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

function claim(id: string, platform: Claim['platform'], orderNo: string): Claim {
  return {
    claim_id: id,
    platform,
    order_no: orderNo,
    paid_date: '2026-10-06',
    status: 'manual_review',
    created_at: '2026-10-07T10:15:00+08:00',
    items: [{ sub_order_id: orderNo, decision: null, reject_reason: null }],
  };
}

function filler(page: number): Claim[] {
  return Array.from({ length: 20 }, (_, index) =>
    claim(`p${page}-${index}`, 'taobao', `9${page}${String(index).padStart(10, '0')}`),
  );
}

/** pages[i] 是第 i 页；最后一页 next_cursor 为 null。 */
function fakeApi(pages: Claim[][]) {
  const cursors: (string | null)[] = [];
  const api = {
    request: vi.fn(
      (_method: string, _path: string, options: { params: { query: { cursor?: string } } }) => {
        const cursor = options.params.query.cursor ?? null;
        cursors.push(cursor);
        const index = cursor === null ? 0 : Number(cursor.slice(1));
        return Promise.resolve({
          items: pages[index] ?? [],
          next_cursor: index + 1 < pages.length ? `c${index + 1}` : null,
        });
      },
    ),
  } as unknown as H5ApiClient;
  return { api, cursors };
}

function mount(api: H5ApiClient, target: LocateTarget, onLocated: () => void) {
  const client = createQueryClient();
  clients.push(client);
  return render(
    createQueryProvider(
      <ClaimRecords api={api} target={target} notice={null} onLocated={onLocated} />,
      client,
    ),
  );
}

function scrolled(): HTMLElement[] {
  return vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts as HTMLElement[];
}

it('[AC-F1-04b-UNIT#9] 30205 目标在第二页：自动取下一页并定位，按规范化后的拼多多单号对上', async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const target = claim('dup', 'pdd', '231006-1234567890');
  const { api, cursors } = fakeApi([filler(0), [...filler(1).slice(0, 5), target]]);
  const onLocated = vi.fn();
  mount(api, { platform: 'pdd', orderNo: '2310061234567890' }, onLocated);
  await waitFor(() => expect(onLocated).toHaveBeenCalledTimes(1));
  expect(cursors).toEqual([null, 'c1']);
  expect(scrolled().map((element) => element.dataset['claimId'])).toEqual(['dup']);
  expect(document.activeElement?.getAttribute('data-claim-id')).toBe('dup');
});

it('[AC-F1-04b-UNIT#10] 一直找不到：自动取到上限后保留目标不结束；列表取完才结束定位', async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const many = Array.from({ length: LOCATE_MAX_PAGES + 2 }, (_, page) => filler(page));
  const first = fakeApi(many);
  const kept = vi.fn();
  mount(first.api, { platform: 'pdd', orderNo: '000' }, kept);
  await waitFor(() => expect(first.cursors).toHaveLength(LOCATE_MAX_PAGES));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(first.cursors).toHaveLength(LOCATE_MAX_PAGES);
  expect(kept).not.toHaveBeenCalled();
  cleanup();

  const short = fakeApi([filler(0), filler(1)]);
  const done = vi.fn();
  mount(short.api, { platform: 'pdd', orderNo: '000' }, done);
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  expect(short.cursors).toEqual([null, 'c1']);
  expect(scrolled()).toHaveLength(0);
});

it('[AC-F1-04b-UNIT#11] 提交成功按 claim_id 定位，第一页就有时不多取', async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const created = claim('new', 'jd', '305678901234');
  const { api, cursors } = fakeApi([[created, ...filler(0)], filler(1)]);
  const onLocated = vi.fn();
  mount(api, { claimId: 'new' }, onLocated);
  await waitFor(() => expect(onLocated).toHaveBeenCalledTimes(1));
  expect(cursors).toEqual([null]);
  expect(scrolled().map((element) => element.dataset['claimId'])).toEqual(['new']);
});
