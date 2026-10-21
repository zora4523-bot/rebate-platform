import type { ReactElement } from 'react';

export type LedgerPageProps = Record<string, never>;

export function LedgerPage(props: LedgerPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: LedgerPage');
}

export { LedgerPage as Component };
