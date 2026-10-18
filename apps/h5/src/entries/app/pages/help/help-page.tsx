import type { ReactElement } from 'react';
import { useApi } from '../../../../shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { Component as PagePending } from '../page-pending.tsx';
import { HelpArticle } from './help-article.tsx';
import { HelpHome } from './help-home.tsx';
import { DEFAULT_BRIDGE, useSupport, type HelpBridge } from './parts.tsx';
import { useSearchParams } from './router.ts';

export interface HelpPageProps {
  /** Injectable SDK facade; production uses @couli/bridge-sdk. */
  bridge?: HelpBridge;
}

/**
 * Help centre (F1-03b, route Help): `/help` is the question list, `/help?article_id=<id>` the
 * article. Opening a question pushes the query string through the router (back returns to the
 * list). Without an App API client the shared placeholder shows and nothing is requested.
 */
export function HelpPage({ bridge = DEFAULT_BRIDGE }: HelpPageProps): ReactElement {
  const api = useApi();
  const openSupport = useSupport(bridge);
  // Checked before any router hook: without a client the placeholder renders on its own.
  if (api === null) return <PagePending />;
  return <HelpContent api={api} openSupport={openSupport} />;
}

function HelpContent({
  api,
  openSupport,
}: {
  api: H5ApiClient;
  openSupport: (() => void) | null;
}): ReactElement {
  const [params] = useSearchParams();
  const articleId = params.get('article_id');
  if (articleId !== null && articleId !== '') {
    return (
      <HelpArticle key={articleId} api={api} articleId={articleId} openSupport={openSupport} />
    );
  }
  return <HelpHome api={api} openSupport={openSupport} />;
}
