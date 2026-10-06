import type { ReactElement } from 'react';
import { StateLayout } from './StateLayout.tsx';
import type { StateProps } from './types.ts';

/** The decorative placeholder exposes data-slot="state-illustration". */
export function EmptyState(props: StateProps): ReactElement {
  return <StateLayout {...props} alert={false} />;
}
