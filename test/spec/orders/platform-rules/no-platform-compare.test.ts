// B1-08za: domain code no longer compares platform names itself. A static scan of
// apps/api/src/modules/orders/** (*.ts; domain/platform-rules/** and *.test.ts excluded), with
// comments blanked out, Node built-ins only. Found: an (in)equality or a `case` with the literal
// 'jd' / 'pdd' / 'taobao' (any quote) on either side, a Set built from such literals (membership
// is a comparison), and an (in)equality with SERVICE_FEE_PLATFORM / PID_SCENE_PLATFORM (constants
// that only spell a platform name; they stay exported, as single-platform values for SQL).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ORDERS_URL, RULES_URL } from './kit.ts';

const ORDERS_DIR = fileURLToPath(ORDERS_URL);
const RULES_DIR = fileURLToPath(RULES_URL).replace(/[\\/]$/, '');

const NAME = String.raw`['"\x60](?:jd|pdd|taobao)['"\x60]`;
const CONSTANT = String.raw`\b(?:SERVICE_FEE_PLATFORM|PID_SCENE_PLATFORM)\b`;
const FINDINGS: readonly RegExp[] = [
  new RegExp(String.raw`[!=]==?\s*${NAME}`),
  new RegExp(String.raw`${NAME}\s*[!=]==?`),
  new RegExp(String.raw`\bcase\s+${NAME}`),
  new RegExp(String.raw`\bnew\s+Set\b[^;]*?${NAME}`),
  new RegExp(String.raw`[!=]==?\s*${CONSTANT}`),
  new RegExp(String.raw`${CONSTANT}\s*[!=]==?`),
];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path !== RULES_DIR) files.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Comments replaced by spaces (line breaks kept, so line numbers stay); string and template
 * literals are copied as they are, so a `//` or `/*` inside one starts no comment.
 */
function withoutComments(text: string): string {
  let out = '';
  let quote = '';
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (quote !== '') {
      if (c === '\\') {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) quote = '';
      out += c;
      i += 1;
      continue;
    }
    const pair = text.slice(i, i + 2);
    if (pair === '//' || pair === '/*') {
      const close = pair === '//' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
      const end = close < 0 ? text.length : pair === '//' ? close : close + 2;
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i += 1;
  }
  return out;
}

it('[AC-B1-08za#19] orders 模块（规则表与单元测试之外）不再与平台名字面量比较、switch 分支或用平台名集合判定', () => {
  const files = sourceFiles(ORDERS_DIR);
  expect(files.length).toBeGreaterThan(50);
  expect(files.some((file) => file.startsWith(RULES_DIR))).toBe(false);
  const found: string[] = [];
  for (const file of files) {
    const lines = withoutComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (FINDINGS.some((pattern) => pattern.test(line))) {
        found.push(`${relative(ORDERS_DIR, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  expect(found).toEqual([]);
});
