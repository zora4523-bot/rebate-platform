// Platform marks page (design-hifi AdmPlatformIcon*; BR-TEXT-24; contracts adminListPlatformIcons,
// adminListPlatformIconVersions, adminPublishPlatformIcon, adminRestoreBuiltinPlatformIcon).
// Skeleton of F1-06zd: the rule tests under test/spec/frontend/admin-platform-icons/ describe it.
import type { ReactElement } from 'react';

export type { BuiltinIconFiles, BuiltinIconUrls } from './builtin.ts';

export interface PlatformIconsPageProps {
  /** Current time (the 「打开于」 line of the conflict notice); defaults to the clock. */
  readonly now?: () => Date;
}

export function PlatformIconsPage(props: PlatformIconsPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: PlatformIconsPage');
}
