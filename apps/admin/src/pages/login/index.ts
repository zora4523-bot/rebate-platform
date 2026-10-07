import type { ReactElement } from 'react';
import type { AdminAuthProvider } from '../../providers/auth/index.ts';
import type { AdminEnvironment } from '../../shell-options.ts';

export interface LoginPageProps {
  readonly authProvider: AdminAuthProvider;
  readonly environment: AdminEnvironment;
  readonly onComplete: () => void;
}

export function LoginPage(props: LoginPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: LoginPage');
}
