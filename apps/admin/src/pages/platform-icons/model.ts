import type { Schema } from '@couli/contracts-ts';
import { platformIconsTexts as t } from '../../texts/platform-icons.ts';

export type Icon = Schema<'AdminPlatformIcon'>;
export type Version = Schema<'AdminPlatformIconVersion'>;
export type ActionKind = 'publish' | 'rollback' | 'restore';
export interface Confirmation {
  readonly kind: ActionKind;
  readonly icon: Icon;
  readonly target?: Version;
  readonly fromHistory: boolean;
  readonly openedAt: string;
  readonly retained: readonly number[];
}
export type ActionError =
  | { readonly kind: 'conflict'; readonly latest?: Icon }
  | { readonly kind: 'version' | 'source' | 'failed' };

export function time(iso: string | null, full = false): string {
  if (iso === null) return t.dash;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return t.dash;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${full ? `${part('year')}-` : ''}${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

export function currentLabel(icon: Icon): string {
  return icon.current_version === null ? t.builtin : t.version(icon.current_version);
}

export function fileLabel(version: Version): string {
  return `${version.format.toUpperCase()} · ${Math.ceil(version.bytes / 1024)} KB · ${version.sanitized ? t.sanitized : version.format === 'png' ? t.original : t.unchanged}`;
}

export function canPublish(version: Version): boolean {
  return version.publishable && Boolean(version.source_url && version.downloaded_on);
}
