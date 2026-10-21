import { call, has } from '@couli/bridge-sdk';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type TouchEvent,
} from 'react';
import { EmptyState, Skeleton } from '../../../../components/base/index.ts';
import { RetryPage } from '../../../../components/retry/index.ts';
import { useApi } from '../../../../shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { ledgerText, ledgerTexts } from '../../../../texts/ledger.ts';
import { Component as PagePending } from '../page-pending.tsx';
import {
  groupByMonth,
  isVisible,
  type LedgerLink,
  type LedgerListData,
  type LedgerRow,
} from './format.ts';

export type LedgerPageProps = Record<string, never>;

/** 每页条数（契约默认 20，上限 50）。 */
const PAGE_LIMIT = 20;
/** 下拉超过这个距离（px）松手才刷新。 */
const PULL_THRESHOLD = 64;
const QUERY_KEY = ['wallet', 'ledger'] as const;

const CARD = 'rounded-couli-card bg-couli-background-surface px-couli-4 shadow-couli-card';
const FOCUS =
  'focus-visible:outline-solid focus-visible:outline-[length:var(--focus-width)] focus-visible:outline-offset-[var(--focus-offset)] focus-visible:outline-couli-focus-ring';
const CAPTION = 'text-couli-caption leading-couli-caption text-couli-text-secondary';

/**
 * 余额流水（F1-04a，路由 Ledger）：经应用级 API 客户端（内部经桥取 H5 令牌）读 listWalletLedger，
 * 按会计月分组；下拉刷新只重取第一页，滚到底按 next_cursor 取下一页。没有 API 客户端（App 外或
 * 未配置）时显示共用占位页，不发请求。
 */
export function LedgerPage(props: LedgerPageProps): ReactElement {
  void props;
  const api = useApi();
  if (api === null) return <PagePending />;
  return <LedgerList api={api} />;
}

function Page({
  children,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
}: {
  children: ReactNode;
  onTouchStart?: (event: TouchEvent) => void;
  onTouchMove?: (event: TouchEvent) => void;
  onTouchEnd?: () => void;
}): ReactElement {
  return (
    <main
      className="flex min-h-dvh min-w-0 flex-col gap-couli-3 bg-couli-background-canvas px-couli-4 pt-couli-2 pb-couli-6 font-couli-system text-couli-text-primary"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {children}
    </main>
  );
}

const ICON = {
  'aria-hidden': true,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function ListIcon(): ReactElement {
  return (
    <svg {...ICON}>
      <rect x="5.5" y="3.5" width="13" height="17" rx="2" />
      <path d="M9 8.5h6M9 12h6M9 15.5h6" />
    </svg>
  );
}

function ChevronIcon(): ReactElement {
  return (
    <svg {...ICON} strokeWidth={1.75} className="size-5 flex-none text-couli-text-secondary">
      <path d="m9.5 6 6 6-6 6" />
    </svg>
  );
}

function RowSkeleton(): ReactElement {
  return (
    <div className="flex items-center gap-couli-3 py-couli-3">
      <div className="flex min-w-0 flex-1 flex-col gap-couli-1">
        <Skeleton width="45%" height="1.3125rem" />
        <Skeleton width="30%" height="1.125rem" />
      </div>
      <Skeleton width="3.5rem" height="1.3125rem" />
    </div>
  );
}

/** 当前文档是否滚在顶部（下拉刷新只在顶部起手时生效）。 */
function atTop(): boolean {
  const scrolled = document.scrollingElement?.scrollTop ?? 0;
  return scrolled <= 0 && window.scrollY <= 0;
}

function LedgerList({ api }: { api: H5ApiClient }): ReactElement {
  const queryClient = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: QUERY_KEY,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.request('GET', '/v1/wallet/ledger', {
        params: {
          query: { limit: PAGE_LIMIT, ...(pageParam === null ? {} : { cursor: pageParam }) },
        },
      }),
    // 游标原样回传；空串或与上一页相同的游标视为到底，避免死循环。
    getNextPageParam: (last, _pages, lastCursor) =>
      last.next_cursor === null || last.next_cursor === '' || last.next_cursor === lastCursor
        ? undefined
        : last.next_cursor,
  });
  const { data, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError } = list;

  // 点按跳转：桥没有 nav.open 时行不可点（不猜路由，不自己拼 URL）。
  const navOpen = useMemo(() => has('nav.open'), []);
  const open = useMemo(() => {
    if (navOpen === null) return null;
    return (link: LedgerLink) => {
      call(navOpen, link).catch(() => undefined);
    };
  }, [navOpen]);

  // 会计日的「同年」按取到数据时的上海日期判断（BR-TEXT-11）。
  const { dataUpdatedAt } = list;
  const groups = useMemo(
    () => groupByMonth(data?.pages.flatMap((page) => page.items) ?? [], dataUpdatedAt),
    [data, dataUpdatedAt],
  );
  const pageCount = data?.pages.length ?? 0;

  // 翻页：同一时间只有一个请求在途（含刷新），到底后不再请求。
  const loadingMore = useRef(false);
  function loadMore(): void {
    if (loadingMore.current || !hasNextPage || isFetching) return;
    loadingMore.current = true;
    list
      .fetchNextPage({ cancelRefetch: false })
      .catch(() => undefined)
      .finally(() => {
        loadingMore.current = false;
      });
  }
  const onReachBottom = useEffectEvent(loadMore);

  // 滚到底：列表末尾的哨兵进入视口时取下一页；每加载一页重建观察器，短列表也能继续触发。
  const sentinel = useRef<HTMLDivElement>(null);
  const showSentinel = hasNextPage && !isFetchNextPageError;
  useEffect(() => {
    const target = sentinel.current;
    if (!showSentinel || target === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) onReachBottom();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [showSentinel, pageCount]);

  // 下拉刷新：丢掉第一页以后的页，只重取第一页一次；刷新在途时不再发起。
  const refreshing = useRef(false);
  const [isRefreshing, setRefreshing] = useState(false);
  function refresh(): void {
    if (refreshing.current) return;
    refreshing.current = true;
    setRefreshing(true);
    queryClient.setQueryData<InfiniteData<LedgerListData, string | null>>(QUERY_KEY, (old) =>
      old === undefined || old.pages.length <= 1
        ? old
        : { pages: old.pages.slice(0, 1), pageParams: old.pageParams.slice(0, 1) },
    );
    list
      .refetch()
      .catch(() => undefined)
      .finally(() => {
        refreshing.current = false;
        setRefreshing(false);
      });
  }
  const pull = useRef<{ startY: number; distance: number } | null>(null);
  function onTouchStart(event: TouchEvent): void {
    const touch = event.touches[0];
    pull.current = touch !== undefined && atTop() ? { startY: touch.clientY, distance: 0 } : null;
  }
  function onTouchMove(event: TouchEvent): void {
    const touch = event.touches[0];
    if (pull.current !== null && touch !== undefined) {
      pull.current.distance = touch.clientY - pull.current.startY;
    }
  }
  function onTouchEnd(): void {
    const gesture = pull.current;
    pull.current = null;
    if (gesture !== null && gesture.distance >= PULL_THRESHOLD) refresh();
  }

  // 首屏失败：H5 加载失败重试页；重试进行中回到骨架。
  if (data === undefined && list.isError && !isFetching) {
    return <RetryPage onRetry={() => void list.refetch()} />;
  }

  if (data === undefined) {
    return (
      <Page>
        <div className={CARD}>
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </div>
      </Page>
    );
  }

  const touch = { onTouchStart, onTouchMove, onTouchEnd };
  const empty = !data.pages.some((page) => page.items.some(isVisible));
  if (empty && !hasNextPage) {
    return (
      <Page {...touch}>
        {isRefreshing ? <Refreshing /> : null}
        <div className="flex justify-center pt-couli-12">
          <EmptyState
            icon={<ListIcon />}
            title={ledgerText('ledger.empty')}
            description={ledgerText('ledger.empty.hint')}
          />
        </div>
      </Page>
    );
  }

  let footer: ReactElement | null = null;
  if (isFetchingNextPage) {
    footer = (
      <div className={CARD}>
        <RowSkeleton />
      </div>
    );
  } else if (isFetchNextPageError) {
    footer = (
      <div className="flex min-h-11 items-center justify-center gap-couli-3">
        <p role="alert" className={CAPTION}>
          {ledgerTexts.moreFailed}
        </p>
        <button
          type="button"
          className={`${FOCUS} min-h-11 flex-none cursor-pointer px-couli-2 text-couli-footnote leading-couli-footnote font-couli-medium text-couli-text-link`}
          onClick={loadMore}
        >
          {ledgerTexts.retry}
        </button>
      </div>
    );
  } else if (!hasNextPage) {
    footer = <p className={`${CAPTION} px-couli-1 text-center`}>{ledgerTexts.end}</p>;
  }

  return (
    <Page {...touch}>
      {isRefreshing ? <Refreshing /> : null}
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-couli-2">
          <h2 className={`${CAPTION} px-couli-1`}>{group.title}</h2>
          <ul className={`${CARD} flex flex-col`}>
            {group.rows.map(({ key, row }) => (
              <LedgerItem key={key} row={row} open={open} />
            ))}
          </ul>
        </section>
      ))}
      {footer}
      {showSentinel ? <div ref={sentinel} aria-hidden="true" className="h-px" /> : null}
    </Page>
  );
}

function Refreshing(): ReactElement {
  return (
    <p role="status" className={`${CAPTION} text-center`}>
      {ledgerTexts.refreshing}
    </p>
  );
}

const ROW = 'flex min-h-11 w-full items-center gap-couli-2 py-couli-3 text-left';

function RowContent({ row }: { row: LedgerRow }): ReactElement {
  const second = row.hint === null ? row.date : `${row.hint} · ${row.date}`;
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-couli-1">
        <span className="text-couli-body leading-couli-body font-couli-medium [overflow-wrap:anywhere]">
          {row.name}
        </span>
        <span className={`${CAPTION} tabular-nums [overflow-wrap:anywhere]`}>{second}</span>
      </span>
      <span className="flex max-w-[55%] flex-none flex-col items-end gap-couli-1 text-right">
        <span
          className={`text-couli-body leading-couli-body font-couli-semibold tabular-nums [overflow-wrap:anywhere] ${
            row.accent ? 'text-couli-rebate-text' : 'text-couli-text-primary'
          }`}
        >
          {row.amount}
        </span>
        {row.balance === null ? null : (
          <span className={`${CAPTION} tabular-nums [overflow-wrap:anywhere]`}>{row.balance}</span>
        )}
      </span>
    </>
  );
}

function Details({ row }: { row: LedgerRow }): ReactElement | null {
  if (row.details === null) return null;
  return (
    <dl className="mb-couli-3 flex flex-col gap-couli-1 rounded-couli-button bg-couli-background-muted p-couli-3 text-couli-footnote leading-couli-footnote text-couli-text-secondary">
      {row.details.map((item) => (
        <div key={item.label} className="flex items-start justify-between gap-couli-3">
          <dt className="min-w-0 [overflow-wrap:anywhere]">{item.label}</dt>
          <dd className="flex-none text-right tabular-nums">{item.amount}</dd>
        </div>
      ))}
    </dl>
  );
}

function LedgerItem({
  row,
  open,
}: {
  row: LedgerRow;
  open: ((link: LedgerLink) => void) | null;
}): ReactElement {
  const labelId = useId();
  const item = 'border-b border-couli-border-subtle last:border-b-0';
  const link = row.link;
  if (link !== null && open !== null) {
    return (
      <li className={item}>
        <button
          type="button"
          className={`${ROW} ${FOCUS} cursor-pointer text-couli-text-primary`}
          onClick={() => open(link)}
        >
          <RowContent row={row} />
          <ChevronIcon />
        </button>
        <Details row={row} />
      </li>
    );
  }
  // 不可点的行：列表项以行内容为可访问名（名称、带符号金额、日期）。
  return (
    <li className={item} aria-labelledby={labelId}>
      <div id={labelId} className={ROW}>
        <RowContent row={row} />
      </div>
      <Details row={row} />
    </li>
  );
}
