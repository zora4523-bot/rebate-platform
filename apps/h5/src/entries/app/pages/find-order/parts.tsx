import type { ReactElement } from 'react';
import type { RecordState } from './model.ts';

/** 卡片、键盘焦点环与文字样式（只用 @couli/ui-tokens 的令牌类）。 */
export const CARD = 'rounded-couli-card bg-couli-background-surface shadow-couli-card';
export const FOCUS =
  'focus-visible:outline-solid focus-visible:outline-[length:var(--focus-width)] focus-visible:outline-offset-[var(--focus-offset)] focus-visible:outline-couli-focus-ring';
export const CAPTION = 'text-couli-caption leading-couli-caption text-couli-text-secondary';
export const FOOTNOTE = 'text-couli-footnote leading-couli-footnote';

const ICON = {
  'aria-hidden': true,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function InfoIcon({ className }: { className: string }): ReactElement {
  return (
    <svg {...ICON} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

export function WarningIcon({ className }: { className: string }): ReactElement {
  return (
    <svg {...ICON} className={className}>
      <path d="M12 4.5 3.5 19h17L12 4.5Z" />
      <path d="M12 10v4M12 16.5h.01" />
    </svg>
  );
}

export function ClockIcon({ className }: { className: string }): ReactElement {
  return (
    <svg {...ICON} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function CheckIcon({ className }: { className: string }): ReactElement {
  return (
    <svg {...ICON} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}

export function ChevronIcon({ className }: { className: string }): ReactElement {
  return (
    <svg {...ICON} className={className}>
      <path d="m9.5 6 6 6-6 6" />
    </svg>
  );
}

export function SearchDocIcon(): ReactElement {
  return (
    <svg {...ICON} strokeWidth={1.6}>
      <path d="M14 20.5H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2V11" />
      <path d="M8.5 8h7M8.5 11.5h4" />
      <circle cx="16.5" cy="16.5" r="2.75" />
      <path d="m18.5 18.5 2 2" />
    </svg>
  );
}

const TAG: Record<RecordState, string> = {
  pending: 'bg-couli-status-pending-background text-couli-status-pending-text',
  auto_tracked: 'bg-couli-background-muted text-couli-text-secondary',
  approved: 'bg-couli-status-success-background text-couli-status-success-text',
  rejected: 'bg-couli-status-warning-background text-couli-status-warning-text',
};

function TagIcon({ state }: { state: RecordState }): ReactElement {
  const className = 'size-couli-3 flex-none';
  switch (state) {
    case 'pending':
      return <ClockIcon className={className} />;
    case 'approved':
      return <CheckIcon className={className} />;
    case 'rejected':
      return <WarningIcon className={className} />;
    default:
      return <InfoIcon className={className} />;
  }
}

/** 记录状态标签（画板 FindOrderRecords-v2：小图标 + 文字的胶囊）。 */
export function StatusTag({ state, label }: { state: RecordState; label: string }): ReactElement {
  return (
    <span
      className={`inline-flex min-h-couli-component-tag-min-height flex-none items-center gap-couli-1 rounded-couli-pill px-couli-2 text-couli-caption leading-couli-caption ${TAG[state]}`}
    >
      <TagIcon state={state} />
      <span>{label}</span>
    </span>
  );
}
