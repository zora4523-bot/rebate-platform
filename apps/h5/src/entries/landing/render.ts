import { t } from '../../shared/texts.ts';

/** Same markup as the React shell, so later pages can take over the node without a jump. */
const SHELL_CLASS = 'flex min-h-dvh items-center justify-center p-6 text-couli-text-secondary';

/**
 * Landing first screen in plain DOM (blocked B-6, default A: the first screen does not depend on
 * React). The real landing pages (F1-05, F1-11) replace the placeholder once B-6 is settled.
 */
export function renderLandingShell(container: HTMLElement): void {
  const main = container.ownerDocument.createElement('main');
  main.className = SHELL_CLASS;
  const note = container.ownerDocument.createElement('p');
  note.textContent = t('h5.shell.page_pending');
  main.append(note);
  container.replaceChildren(main);
}

export { SHELL_CLASS };
