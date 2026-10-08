import type { ReactElement } from 'react';
import type { Schema } from '@couli/contracts-ts';

export type PlatformKey = keyof Schema<'ConfigPlatformIcons'>;

export interface PlatformBadgeProps {
  platform: PlatformKey;
  remote?: Schema<'ConfigPlatformIcon'> | undefined;
}

export function PlatformBadge(props: PlatformBadgeProps): ReactElement {
  void props;
  throw new Error('NotImplemented: PlatformBadge');
}
