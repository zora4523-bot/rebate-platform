import type { ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';

export function HomeConfigPage(props: { readonly access: AccessControl }): ReactElement {
  void props;
  throw new Error('NotImplemented: HomeConfigPage');
}
