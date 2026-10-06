import type { ReactElement } from 'react';

export interface RetryPageProps {
  onRetry: () => void;
}

export function RetryPage(props: RetryPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: RetryPage');
}
