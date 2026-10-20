import type { ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';

export function AuditLogsPage(props: { readonly access: AccessControl }): ReactElement {
  void props;
  throw new Error('NotImplemented: AuditLogsPage');
}

export function AuditLogDetailPage(props: {
  readonly id: string;
  readonly access: AccessControl;
}): ReactElement {
  void props;
  throw new Error('NotImplemented: AuditLogDetailPage');
}
