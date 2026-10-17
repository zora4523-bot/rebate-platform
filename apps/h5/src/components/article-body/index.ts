import type { ReactElement } from 'react';

export interface ArticleBodyProps {
  body: string;
  /** Optional deployment configuration override; absent configuration must fail closed. */
  mediaCdnOrigin?: string;
}

export function ArticleBody(props: ArticleBodyProps): ReactElement {
  void props;
  throw new Error('NotImplemented: ArticleBody');
}
