import type { ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';

interface UsersPageProps {
  readonly access: AccessControl;
}

export function UsersPage(props: UsersPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: UsersPage');
}
