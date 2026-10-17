import { AdminApiError } from '../../providers/data/index.ts';
import { platformIconsTexts as t } from '../../texts/platform-icons.ts';

export function errorFields(error: unknown): readonly unknown[] {
  if (!(error instanceof AdminApiError) || error.code !== 20001) return [];
  const data = error.data;
  return typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields)
    ? data.fields
    : [];
}

export function uploadErrorMessage(error: unknown): string {
  if (!(error instanceof AdminApiError)) return t.uploadFailed;
  if (error.httpStatus === 413 && errorFields(error).includes('body')) return t.tooLarge;
  if (error.code === 20001 && typeof error.data === 'object' && error.data !== null) {
    const reason = 'reason' in error.data ? error.data.reason : undefined;
    if (reason === 'icon_format_invalid') return t.formatInvalid;
    if (reason === 'icon_too_large') return t.tooLarge;
    if (reason === 'icon_svg_unconvertible') return t.unconvertible;
  }
  return t.uploadFailed;
}
