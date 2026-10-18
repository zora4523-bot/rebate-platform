import type { ReactElement } from 'react';
import type { AppApiBridge } from '../../../../shared/api/app-api.ts';

export interface HelpPageProps {
  /** Injectable SDK facade; production uses @couli/bridge-sdk. */
  bridge?: Pick<AppApiBridge, 'isInApp' | 'has' | 'call'>;
}

export function HelpPage(props: HelpPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: HelpPage');
}

export { HelpPage as Component };
