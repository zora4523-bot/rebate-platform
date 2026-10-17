import type { ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';

export function ConfigCenterPage(props: { readonly access: AccessControl }): ReactElement {
  void props;
  throw new Error('NotImplemented: ConfigCenterPage');
}
