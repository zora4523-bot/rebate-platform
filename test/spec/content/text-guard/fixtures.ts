import { readFileSync } from 'node:fs';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import type { BannedWord } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import type { FundTermKeys } from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';

const root = new URL('../../../../', import.meta.url);

export const words = (
  parseYamlLite(readFileSync(new URL('specs/banned-words.yaml', root), 'utf8')) as {
    words: BannedWord[];
  }
).words;

export const fundTermKeys = parseYamlLite(
  readFileSync(new URL('specs/fund-term-keys.yaml', root), 'utf8'),
) as FundTermKeys;

export const defaults = (
  JSON.parse(readFileSync(new URL('contracts/texts.default.json', root), 'utf8')) as {
    texts: Record<string, string>;
  }
).texts;

export const vectors = JSON.parse(
  readFileSync(new URL('specs/banned-words.vectors.json', root), 'utf8'),
) as {
  counts: { hit: number; pass: number };
  cases: { input: string; normalized: string; hits: string[] }[];
};
