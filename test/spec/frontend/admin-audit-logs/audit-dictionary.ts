import { readFileSync } from 'node:fs';
import type { ExportStatus } from './audit-fixtures.ts';

const moduleUrl = import.meta.url;
const dictionary = JSON.parse(
  readFileSync(new URL('../../../../contracts/texts.admin.default.json', moduleUrl), 'utf8'),
) as { texts: Record<string, string> };

export function statusText(status: ExportStatus): string {
  return dictionary.texts[`admin_dict.export_status.${status}`]!;
}
