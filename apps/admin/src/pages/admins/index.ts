import type { ReactElement } from 'react';

export interface AdminsPageProps {
  readonly now?: () => Date;
}

export function AdminsPage(props: AdminsPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: AdminsPage');
}
