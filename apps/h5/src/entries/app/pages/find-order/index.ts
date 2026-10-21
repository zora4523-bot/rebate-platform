import type { ReactElement } from 'react';
import type { AppApiBridge } from '../../../../shared/api/app-api.ts';

export interface FindOrderPageProps {
  bridge?: AppApiBridge;
}

export function FindOrderPage(props: FindOrderPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: FindOrderPage');
}

export { FindOrderPage as Component };
