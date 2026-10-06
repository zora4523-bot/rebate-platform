import type { ReactElement } from 'react';
import type { StateProps } from './types.ts';

/** The decorative placeholder exposes data-slot="state-illustration". */
export function ErrorState(props: StateProps): ReactElement {
  void props;
  throw new Error('NotImplemented: ErrorState');
}
