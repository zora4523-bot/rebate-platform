import type { ReactElement } from 'react';
import type { Schema } from '@couli/contracts-ts';
import type { AccessControl } from '../../providers/access-control/index.ts';

export interface AppVersionsPageProps {
  readonly access: AccessControl;
}

export interface AppVersionEditorProps extends AppVersionsPageProps {
  readonly platform: Schema<'AppVersionEditablePlatform'>;
  readonly channel: Schema<'InstallChannelCode'>;
}

export function AppVersionsPage(props: AppVersionsPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: AppVersionsPage');
}

/** Editor boundary shared by a dialog or a routed page, including a not-yet-created row. */
export function AppVersionEditor(props: AppVersionEditorProps): ReactElement {
  void props;
  throw new Error('NotImplemented: AppVersionEditor');
}
