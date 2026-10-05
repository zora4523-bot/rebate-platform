import type { ReactElement } from 'react';

/** App-external shell: no bridge initialization and no token manager. */
export function createLandingShell(): ReactElement {
  throw new Error('NotImplemented: createLandingShell');
}
