import type { ReactElement } from 'react';
import type { H5ApiClient } from '../../../../shared/api/index.ts';

export interface RulesPageProps {
  /** Tests and embedding callers can supply the existing H5 API client. */
  api?: H5ApiClient;
  mediaCdnOrigin?: string;
}

export function RulesPage(props: RulesPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: RulesPage');
}

export { RulesPage as Component };
