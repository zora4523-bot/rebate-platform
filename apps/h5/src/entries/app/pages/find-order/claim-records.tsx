import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useRef, type ReactElement } from 'react';
import { EmptyState, Skeleton } from '../../../../components/base/index.ts';
import { PlatformBadge } from '../../../../components/platform/index.ts';
import { RetryPage } from '../../../../components/retry/index.ts';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { findOrderText, findOrderTexts } from '../../../../texts/find-order.ts';
import {
  recordView,
  stateLabel,
  type Claim,
  type ClaimPlatform,
  type RecordView,
} from './model.ts';
import { CAPTION, CARD, FOCUS, FOOTNOTE, InfoIcon, SearchDocIcon, StatusTag } from './parts.tsx';

/** 找回记录的查询键；提交成功后让它失效，切回记录页签时重取。 */
export const RECORDS_KEY = ['orders', 'claims'] as const;
/** 每页条数（契约上限 50）。 */
const PAGE_LIMIT = 20;

/** 要定位的申请：提交成功按 claim_id；30205 按平台与订单号。 */
export type LocateTarget = { claimId: string } | { platform: ClaimPlatform; orderNo: string };

function matches(claim: Claim, target: LocateTarget): boolean {
  return 'claimId' in target
    ? claim.claim_id === target.claimId
    : claim.platform === target.platform && claim.order_no === target.orderNo;
}

export interface ClaimRecordsProps {
  api: H5ApiClient;
  target: LocateTarget | null;
  /** 30205 的轻提示（页内文字）。 */
  notice: string | null;
  onLocated: () => void;
}

function RecordSkeleton(): ReactElement {
  return (
    <div className={`${CARD} flex flex-col gap-couli-2 p-couli-4`}>
      <Skeleton width="40%" height="1.25rem" />
      <Skeleton width="70%" height="1.3125rem" />
      <Skeleton width="50%" height="1.125rem" />
    </div>
  );
}

/**
 * 找回记录（编排裁定 4）：经应用级 API 客户端（带 H5 令牌的 GET）读 listOrderClaims，按服务端顺序显示；
 * 每行 PlatformBadge + 状态标签 + 订单号 + 付款日期与提交时间 + 说明句，多个子订单分行显示各自的决定；
 * 不显示认领方。请求只来自进页签、重试与翻页，关掉一切自动重取（10405 等不自动重放）。
 */
export function ClaimRecords({ api, target, notice, onLocated }: ClaimRecordsProps): ReactElement {
  const list = useInfiniteQuery({
    queryKey: RECORDS_KEY,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.request('GET', '/v1/orders/claims', {
        params: {
          query: { limit: PAGE_LIMIT, ...(pageParam === null ? {} : { cursor: pageParam }) },
        },
      }),
    getNextPageParam: (last, _pages, lastCursor) =>
      last.next_cursor === null || last.next_cursor === '' || last.next_cursor === lastCursor
        ? undefined
        : last.next_cursor,
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
  const { data, isFetching, hasNextPage, isFetchingNextPage, isFetchNextPageError } = list;
  const claims = data?.pages.flatMap((page) => page.items) ?? [];

  // 定位：数据取完后找到目标申请，滚到可见并聚焦；找不到（例如在更早的页）就只停在记录页签。
  const cards = useRef(new Map<string, HTMLElement>());
  const located = useEffectEvent(onLocated);
  useEffect(() => {
    if (target === null || data === undefined || isFetching) return;
    const claim = data.pages.flatMap((page) => page.items).find((item) => matches(item, target));
    const element = claim === undefined ? undefined : cards.current.get(claim.claim_id);
    if (element !== undefined) {
      if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center' });
      }
      element.focus({ preventScroll: true });
    }
    located();
  }, [target, data, isFetching]);

  const banner =
    notice === null ? null : (
      <p
        role="status"
        className={`flex items-center gap-couli-2 rounded-couli-button bg-couli-background-surface px-couli-3 py-couli-3 ${FOOTNOTE} text-couli-text-primary`}
      >
        <InfoIcon className="size-couli-4 flex-none text-couli-text-secondary" />
        <span className="min-w-0">{notice}</span>
      </p>
    );

  // 首屏失败：H5 加载失败重试页，重试只再请求一次。
  if (data === undefined && list.isError && !isFetching) {
    return <RetryPage onRetry={() => void list.refetch()} />;
  }
  if (data === undefined) {
    return (
      <div className="flex flex-col gap-couli-3">
        {banner}
        <RecordSkeleton />
        <RecordSkeleton />
      </div>
    );
  }
  if (claims.length === 0 && !hasNextPage) {
    return (
      <div className="flex flex-col gap-couli-3">
        {banner}
        <div className="flex justify-center pt-couli-12">
          <EmptyState
            icon={<SearchDocIcon />}
            title={findOrderText('claim.records.empty')}
            description=""
          />
        </div>
      </div>
    );
  }

  // 「同年 / 今天」按取到数据时的上海时间判断（BR-TEXT-11）。
  const now = list.dataUpdatedAt;
  return (
    <div className="flex flex-col gap-couli-3">
      {banner}
      <ul className="flex flex-col gap-couli-3">
        {claims.map((claim) => (
          <li key={claim.claim_id}>
            <RecordCard
              view={recordView(claim, now)}
              register={(element) => {
                if (element === null) cards.current.delete(claim.claim_id);
                else cards.current.set(claim.claim_id, element);
              }}
            />
          </li>
        ))}
      </ul>
      {isFetchingNextPage ? <RecordSkeleton /> : null}
      {isFetchNextPageError ? (
        <p role="alert" className={`${CAPTION} text-center`}>
          {findOrderTexts.moreFailed}
        </p>
      ) : null}
      {hasNextPage && !isFetchingNextPage ? (
        <button
          type="button"
          onClick={() => void list.fetchNextPage({ cancelRefetch: false })}
          className={`${FOCUS} min-h-11 cursor-pointer self-center px-couli-3 ${FOOTNOTE} font-couli-medium text-couli-text-link`}
        >
          {findOrderTexts.more}
        </button>
      ) : null}
      <p className={`${CAPTION} pt-couli-1 text-center`}>{findOrderText('claim.records.footer')}</p>
    </div>
  );
}

function RecordCard({
  view,
  register,
}: {
  view: RecordView;
  register: (element: HTMLElement | null) => void;
}): ReactElement {
  const single = view.lines.length === 1 && view.lines[0]?.subOrderId === null;
  return (
    <article
      ref={register}
      tabIndex={-1}
      data-claim-id={view.claimId}
      className={`${CARD} ${FOCUS} flex flex-col gap-couli-1 p-couli-4`}
    >
      <div className="flex items-center justify-between gap-couli-2">
        {view.platform === null ? <span /> : <PlatformBadge platform={view.platform} />}
        <StatusTag state={view.state} label={stateLabel(view.state)} />
      </div>
      <p className="mt-couli-2 text-couli-footnote leading-couli-footnote font-couli-semibold tabular-nums [overflow-wrap:anywhere]">
        {findOrderTexts.orderNo} {view.orderNo}
      </p>
      <p className={`${CAPTION} tabular-nums`}>
        {findOrderTexts.paidDate} {view.paidDate} · {findOrderTexts.submittedAt} {view.createdAt}
      </p>
      <div className="mt-couli-2 border-t border-couli-border-subtle pt-couli-3">
        {single ? (
          <p className={`${FOOTNOTE} [overflow-wrap:anywhere]`}>{view.lines[0]?.text}</p>
        ) : (
          <ul className="flex flex-col gap-couli-3">
            {view.lines.map((line) => (
              <li key={line.subOrderId} className="flex flex-col gap-couli-1">
                <div className="flex items-center justify-between gap-couli-2">
                  <span className={`${CAPTION} min-w-0 tabular-nums [overflow-wrap:anywhere]`}>
                    {findOrderTexts.subOrder} {line.subOrderId}
                  </span>
                  <StatusTag state={line.state} label={stateLabel(line.state)} />
                </div>
                <p className={`${FOOTNOTE} [overflow-wrap:anywhere]`}>{line.text}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
