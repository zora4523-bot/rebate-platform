import type { ReactElement } from 'react';
import { t } from '../../shared/texts.ts';
import { SHELL_CLASS } from './render.ts';

/**
 * React form of the landing shell (same markup as renderLandingShell). The landing build does
 * not mount it: its first screen is plain DOM until B-6 decides how the real pages use React.
 */
export function createLandingShell(): ReactElement {
  return (
    <main className={SHELL_CLASS}>
      <p>{t('h5.shell.page_pending')}</p>
    </main>
  );
}
