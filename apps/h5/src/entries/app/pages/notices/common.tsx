import type { ReactElement, ReactNode } from 'react';
import { ApiError } from '../../../../shared/api/index.ts';

/** Unknown, unpublished or taken-down article (contracts/error-codes.yaml). */
const ARTICLE_NOT_FOUND = 30701;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
/** Published articles change rarely; going back and forth reuses what was loaded. */
export const ARTICLE_STALE_MS = 5 * 60 * 1000;

export function isArticleNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === ARTICLE_NOT_FOUND;
}

/** Beijing time (UTC+8, no daylight saving) of an RFC 3339 instant as YYYY-MM-DDTHH:mm; null if invalid. */
function beijing(instant: string): string | null {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return null;
  return new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 16);
}

/** Beijing calendar date YYYY-MM-DD; null if the instant is invalid. */
export function beijingDate(instant: string): string | null {
  return beijing(instant)?.slice(0, 10) ?? null;
}

/** Beijing date and minute YYYY-MM-DD HH:mm; null if the instant is invalid. */
export function beijingDateTime(instant: string): string | null {
  return beijing(instant)?.replace('T', ' ') ?? null;
}

export const CARD = 'rounded-couli-card bg-couli-background-surface shadow-couli-card';
export const FOCUS =
  'focus-visible:outline-solid focus-visible:outline-[length:var(--focus-width)] focus-visible:outline-offset-[var(--focus-offset)] focus-visible:outline-couli-focus-ring';
export const TITLE =
  'text-couli-title leading-couli-title font-couli-semibold text-couli-text-primary';

/** Page column below the native navigation bar (the H5 never draws its own title bar). */
export function Page({ children }: { children: ReactNode }): ReactElement {
  return (
    <main className="flex min-h-dvh flex-col gap-couli-3 bg-couli-background-canvas px-couli-4 pt-couli-2 pb-couli-6 font-couli-system text-couli-text-primary">
      {children}
    </main>
  );
}

export function CenteredState({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex flex-1 items-center justify-center py-couli-16">{children}</div>;
}

const ICON = {
  'aria-hidden': true,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function DocumentIcon(): ReactElement {
  return (
    <svg {...ICON}>
      <path d="M7 3.5h7l4 4v13H7v-17Z" />
      <path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6" />
    </svg>
  );
}

/** Load-failure illustration of the error states (circle with an exclamation mark). */
export function AlertIcon(): ReactElement {
  return (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16.2v.3" />
    </svg>
  );
}

export function ChevronIcon(): ReactElement {
  return (
    <svg {...ICON} strokeWidth={1.75} className="size-5 flex-none text-couli-text-secondary">
      <path d="m9.5 6 6 6-6 6" />
    </svg>
  );
}
