import { useEffect, useState, type ReactElement } from 'react';
import { LAYER } from './styles.ts';

export interface ToastProps {
  message: string;
  /** Milliseconds until the status disappears; omitted means 2000. */
  durationMs?: number;
}

const DEFAULT_DURATION_MS = 2000;

/**
 * Light notice at the bottom centre. A polite live region that never takes focus; it removes
 * itself after `durationMs`. Mount a new instance (for example with a new `key`) per notice.
 */
export function Toast({
  message,
  durationMs = DEFAULT_DURATION_MS,
}: ToastProps): ReactElement | null {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), durationMs);
    return () => clearTimeout(timer);
  }, [durationMs]);

  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`${LAYER} pointer-events-none inset-x-couli-4 mx-auto w-fit max-w-full rounded-couli-button bg-couli-text-primary px-couli-4 py-couli-2 text-center text-couli-footnote leading-couli-footnote text-couli-text-inverse [box-shadow:var(--shadow-floating)]`}
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + var(--space-16))' }}
    >
      {message}
    </div>
  );
}
