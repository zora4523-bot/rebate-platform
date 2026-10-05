import type { ReactElement } from 'react';

/** App-external pages (invite-landing, share-landing, download-guide) mount here later. */
export function createLandingShell(): ReactElement {
  return <main className="min-h-dvh" />;
}
