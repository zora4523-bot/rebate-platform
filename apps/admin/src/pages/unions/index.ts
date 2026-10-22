import type { ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';
import type { AuthClock } from '../../providers/auth/index.ts';

export interface UnionsPageProps {
  readonly access: AccessControl;
  readonly clock?: AuthClock | undefined;
}

export function UnionsPage(props: UnionsPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: UnionsPage');
}

export function UnionOAuthCallbackPage(props: UnionsPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: UnionOAuthCallbackPage');
}
