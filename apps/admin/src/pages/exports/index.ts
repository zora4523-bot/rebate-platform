import type { ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';

export function ExportsPage(props: { readonly access: AccessControl }): ReactElement {
  void props;
  throw new Error('NotImplemented: ExportsPage');
}
