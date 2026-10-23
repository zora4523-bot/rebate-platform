import type { ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';

export interface RiskPageProps {
  readonly access: AccessControl;
}

export function RiskPage(props: RiskPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: RiskPage');
}
