import type { ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';

export function OrdersPage(props: { readonly access: AccessControl }): ReactElement {
  void props;
  throw new Error('NotImplemented: OrdersPage');
}

export function OrderDetailPage(props: {
  readonly access: AccessControl;
  readonly orderId: string;
}): ReactElement {
  void props;
  throw new Error('NotImplemented: OrderDetailPage');
}
