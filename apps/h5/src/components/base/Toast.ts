import type { ReactElement } from 'react';

export interface ToastProps {
  message: string;
  /** Milliseconds until the status disappears; omitted means 2000. */
  durationMs?: number;
}

export function Toast(props: ToastProps): ReactElement | null {
  void props;
  throw new Error('NotImplemented: Toast');
}
