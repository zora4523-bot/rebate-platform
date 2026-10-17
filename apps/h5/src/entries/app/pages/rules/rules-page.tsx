import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArticleBody } from '../../../../components/article-body/index.ts';
import { EmptyState, ErrorState, Skeleton } from '../../../../components/base/index.ts';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { rulesTexts } from '../../../../texts/rules.ts';
import { Component as PagePending } from '../page-pending.tsx';

export interface RulesPageProps {
  /** Tests and embedding callers can supply the existing H5 API client. */
  api?: H5ApiClient;
  /** Media CDN origin for body images; absent, no image is shown (wiring is a later task). */
  mediaCdnOrigin?: string;
}

/** Rule articles change rarely; switching back and forth reuses what was loaded. */
const STALE_MS = 5 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Calendar date in Beijing (UTC+8, no daylight saving) of an RFC 3339 instant; null if invalid. */
export function beijingDate(instant: string): string | null {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return null;
  return new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

const CARD = 'rounded-couli-card bg-couli-background-surface shadow-couli-card';

function DocumentIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5 flex-none"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 3.5h7l4 4v13H7v-17Z" />
      <path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6" />
    </svg>
  );
}

/** Load-failure illustration of the error states (circle with an exclamation mark). */
function AlertIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16.2v.3" />
    </svg>
  );
}

function ChevronIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5 flex-none text-couli-text-secondary"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9.5 6 6 6-6 6" />
    </svg>
  );
}

function ArticleSkeleton(): ReactElement {
  return (
    <div className="flex flex-col gap-couli-3">
      <Skeleton width="100%" height="1.0625rem" />
      <Skeleton width="100%" height="1.0625rem" />
      <Skeleton width="60%" height="1.0625rem" />
    </div>
  );
}

function Page({ children }: { children: ReactNode }): ReactElement {
  return (
    <main className="flex min-h-dvh flex-col gap-couli-3 bg-couli-background-canvas px-couli-4 pt-couli-2 pb-couli-6 font-couli-system text-couli-text-primary">
      {children}
    </main>
  );
}

function CenteredState({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex flex-1 items-center justify-center py-couli-16">{children}</div>;
}

/**
 * Rules page (F1-03a, route Rules): the first article of category `rule` in server order in
 * full, the others as entries at the bottom that switch the article in place (the URL stays).
 * Loading, empty and error states; a retry resends only the request that failed.
 */
export function RulesPage({ api, mediaCdnOrigin }: RulesPageProps): ReactElement {
  // TODO(规划/11 §2.1): pass the app-level H5 API client (base URL, common headers) from the app
  // shell — blocked on the app-level API client wiring task (apps/h5 has none yet). Until then the
  // route keeps the shared "page not open yet" placeholder and sends no request.
  if (api === undefined) return <PagePending />;
  return <RulesContent api={api} {...(mediaCdnOrigin === undefined ? {} : { mediaCdnOrigin })} />;
}

function RulesContent({
  api,
  mediaCdnOrigin,
}: RulesPageProps & { api: H5ApiClient }): ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const switched = useRef(false);

  const list = useQuery({
    queryKey: ['articles', 'rule'],
    queryFn: () => api.request('GET', '/v1/articles', { params: { query: { category: 'rule' } } }),
    staleTime: STALE_MS,
  });
  const items = list.data?.items ?? [];
  const selected = items.find((item) => item.article_id === selectedId) ?? items[0];
  const articleId = selected?.article_id;

  const detail = useQuery({
    queryKey: ['articles', 'detail', articleId],
    queryFn: () =>
      api.request('GET', '/v1/articles/{article_id}', {
        params: { path: { article_id: articleId! } },
      }),
    enabled: articleId !== undefined,
    staleTime: STALE_MS,
  });

  // After an in-page switch, start reading the new article from its title.
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    // jsdom and some older WebViews have no scrollingElement.
    const scroller = document.scrollingElement as Element | null | undefined;
    if (scroller != null) scroller.scrollTop = 0;
    titleRef.current?.focus({ preventScroll: true });
  }, [articleId]);

  // While a retry is in flight the skeleton shows again.
  if (list.data === undefined && list.isError && !list.isFetching) {
    return (
      <Page>
        <CenteredState>
          <ErrorState
            icon={<AlertIcon />}
            title={rulesTexts.loadFailedTitle}
            description={rulesTexts.loadFailedDescription}
            action={{ label: rulesTexts.retry, onClick: () => void list.refetch() }}
          />
        </CenteredState>
      </Page>
    );
  }

  if (list.data === undefined) {
    return (
      <Page>
        <article className={`${CARD} flex flex-col gap-couli-4 p-couli-4`}>
          <Skeleton width="40%" height="1.375rem" />
          <ArticleSkeleton />
        </article>
      </Page>
    );
  }

  if (selected === undefined) {
    return (
      <Page>
        <CenteredState>
          <EmptyState
            icon={<DocumentIcon />}
            title={rulesTexts.emptyTitle}
            description={rulesTexts.emptyDescription}
          />
        </CenteredState>
      </Page>
    );
  }

  const article = detail.data?.article_id === selected.article_id ? detail.data : undefined;
  const updated = beijingDate(article?.published_at ?? selected.published_at);
  const others = items.filter((item) => item.article_id !== selected.article_id);

  let body: ReactElement;
  if (article !== undefined) {
    body = (
      <ArticleBody
        body={article.body}
        {...(mediaCdnOrigin === undefined ? {} : { mediaCdnOrigin })}
      />
    );
  } else if (detail.isError && !detail.isFetching) {
    body = (
      <div className="py-couli-6">
        <ErrorState
          icon={<AlertIcon />}
          title={rulesTexts.loadFailedTitle}
          description={rulesTexts.loadFailedDescription}
          action={{ label: rulesTexts.retry, onClick: () => void detail.refetch() }}
        />
      </div>
    );
  } else {
    body = <ArticleSkeleton />;
  }

  return (
    <Page>
      <article className={`${CARD} flex flex-col gap-couli-4 p-couli-4`}>
        <header className="flex flex-col gap-couli-4">
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="text-couli-title leading-couli-title font-couli-semibold text-couli-text-primary outline-none"
          >
            {article?.title ?? selected.title}
          </h1>
          {updated === null ? null : (
            <p className="text-couli-caption leading-couli-caption text-couli-text-secondary tabular-nums">
              {rulesTexts.updatedAt(updated)}
            </p>
          )}
        </header>
        {body}
      </article>
      {others.length === 0 ? null : (
        <nav aria-label={rulesTexts.otherRules} className={`${CARD} px-couli-4 py-couli-1`}>
          <ul className="flex flex-col divide-y divide-couli-border-subtle">
            {others.map((item) => (
              <li key={item.article_id}>
                <button
                  type="button"
                  className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-couli-3 py-couli-2 text-left text-couli-footnote leading-couli-footnote text-couli-text-primary focus-visible:outline-solid focus-visible:outline-[length:var(--focus-width)] focus-visible:outline-offset-[var(--focus-offset)] focus-visible:outline-couli-focus-ring"
                  onClick={() => {
                    switched.current = true;
                    setSelectedId(item.article_id);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-couli-3">
                    <DocumentIcon />
                    <span className="min-w-0 break-words">{item.title}</span>
                  </span>
                  <ChevronIcon />
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </Page>
  );
}
