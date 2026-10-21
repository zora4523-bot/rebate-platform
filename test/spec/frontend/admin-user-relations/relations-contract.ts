import { readFileSync } from 'node:fs';

const moduleUrl = import.meta.url;
const contract = readFileSync(new URL('../../../../contracts/openapi.yaml', moduleUrl), 'utf8');
const reasonSchema = contract.match(/    AdminUserReason:\n([\s\S]*?)(?=\n    \w)/)?.[1] ?? '';
export const REASON_MAX = Number(reasonSchema.match(/maxLength: (\d+)/)?.[1]);
const texts = JSON.parse(
  readFileSync(new URL('../../../../contracts/texts.default.json', moduleUrl), 'utf8'),
) as { texts: Record<string, string> };
export function errorText(code: number): string {
  const value = texts.texts[`error.${code}`];
  if (!value) throw new Error(`Missing contract text error.${code}`);
  return value;
}
