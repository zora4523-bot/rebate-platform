import { readFileSync } from 'node:fs';
import type { RunTexts } from '../run/index.ts';

const document = JSON.parse(
  readFileSync(
    new URL('../../../../../../../contracts/texts.default.json', import.meta.url),
    'utf8',
  ),
) as { texts: Record<string, string>; fallbacks: Record<string, string> };

function errorText(code: number): string | undefined {
  const key = `error.${String(code)}`;
  const text = document.fallbacks[key] ?? document.texts[key];
  return typeof text === 'string' && !/\{[^{}]+\}/u.test(text) ? text : undefined;
}

const serverError = errorText(50001);
if (serverError === undefined) throw new Error('Missing placeholder-free error.50001');
const texts: Pick<RunTexts, 'errorMsg'> = Object.freeze({
  errorMsg: (code: number): string => errorText(code) ?? serverError,
});

export function agentDefaultTexts(): Pick<RunTexts, 'errorMsg'> {
  return texts;
}

export function agentText(key: string): string {
  const value = document.texts[key];
  if (typeof value !== 'string') throw new Error('Missing agent text');
  return value;
}
