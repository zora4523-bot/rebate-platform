// Static rule test for 规划/08 BR-CALC-01: no floating point on any money path in
// packages/money (parseFloat, toFixed, Math.round and the other Math rounding helpers).
// ESLint already bans parseFloat / toFixed there; this test adds Math.* rounding and keeps the
// rule enforced even if the lint config changes. Comments are stripped before scanning.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../../packages/money/src/', import.meta.url));
const FORBIDDEN =
  /\bparseFloat\b|\btoFixed\b|\btoPrecision\b|\bMath\.(round|floor|ceil|trunc|fround)\b/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

it('[BR-CALC-01] packages/money/src 的非测试源码不出现 parseFloat、toFixed、toPrecision、Math.round/floor/ceil/trunc/fround', () => {
  const files = sourceFiles(SRC);
  const hits = files.flatMap((file) =>
    [...stripComments(readFileSync(file, 'utf8')).matchAll(FORBIDDEN)].map(
      (m) => `${file.slice(SRC.length)}: ${m[0]}`,
    ),
  );
  expect({ scanned_index: files.some((f) => f.endsWith('index.ts')), hits }).toEqual({
    scanned_index: true,
    hits: [],
  });
});
