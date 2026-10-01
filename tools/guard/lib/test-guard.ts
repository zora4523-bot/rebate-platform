// Static checks on test files, vitest configs and package scripts
// (规划/11 §2.3 step 5, §4.1, §4.2, §4.3; conventions C5).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Change } from '../../lib/git.ts';
import type { ProtectedConfig, ProtectedHit } from './protected.ts';
import { findProtectedHits } from './protected.ts';

export type Finding = { file: string; line: number; rule: string; message: string };

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const INT_TEST_FILE = /\.int\.test\.[cm]?[jt]sx?$/;
const VITEST_CONFIG = /(^|\/)vitest[^/]*\.config\.[^/]+$|(^|\/)vitest\.shared\.ts$/;
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const RULE_TEST_DIR = /^test\/(spec|properties)\//;
const ACCEPTANCE_DIR = /^test\/acceptance\//;

// Modules a unit test must not import: they need a database, Docker or the network.
const INTEGRATION_ONLY = ['pg', 'pg-boss', 'testcontainers', '@couli/db/testing'];
const INTEGRATION_ONLY_SCOPES = ['@testcontainers/'];

const SKIP_OR_ONLY = /\.\s*(skip|only|skipIf|runIf|todo)\b(?=\s*[(.`])/;
const X_PREFIXED = /(?<![\w$.])(xit|xtest|xdescribe|fit|fdescribe)\s*\(/;
const RETRY_KEY = /\bretry\s*:\s*([^\s,})]+)/;
const RETRY_SHORTHAND = /[{,]\s*retry\s*[,}]/;
const PASS_WITH_NO_TESTS = /\bpassWithNoTests\s*:\s*(?!\s|false\b)/;
const ALLOW_ONLY = /\ballowOnly\s*:\s*(?!\s|false\b)/;
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;
const LISTEN_CALL = /\.\s*listen\s*\(/;
const ADMIN_URL = /TEST_PG_ADMIN_URL/g;
// The one accepted reference: asserting that the superuser URL did not leak into a test worker.
const ADMIN_URL_ABSENT =
  /expect\(\s*process\.env(?:\.TEST_PG_ADMIN_URL|\[\s*['"]TEST_PG_ADMIN_URL['"]\s*\])\s*\)\s*\.toBeUndefined\(\)/g;
const DESCRIBE_CALL = /(?<![\w$.])describe\s*(?:\.\s*\w+\s*)*[(`]/;
const MOCK_CALL = /\bvi\s*\.\s*(?:mock|doMock)\s*\(\s*(['"`])([^'"`\n]+)\1/g;
const AC_TAG = /\[AC-[A-Z][A-Z0-9]*-\d+(?:#\d+)?\]/;
const BAD_SCRIPT_FLAG = /--?passWithNoTests\b|--retry\b|--allowOnly\b/;

function isZeroLiteral(value: string): boolean {
  return /^0(?![\d.xXbBoO_])/.test(value);
}

function isIntegrationOnly(specifier: string): boolean {
  return (
    INTEGRATION_ONLY.some((m) => specifier === m || specifier.startsWith(`${m}/`)) ||
    INTEGRATION_ONLY_SCOPES.some((s) => specifier.startsWith(s))
  );
}

function isFundsCoreModule(specifier: string): boolean {
  return (
    specifier === '@couli/money' ||
    specifier.startsWith('@couli/money/') ||
    /(^|\/)packages\/money(\/|$)/.test(specifier) ||
    /(^|\/)ledger(\/|\.|$)/.test(specifier)
  );
}

function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** Index just after the string literal starting at `start` (a quote or backtick), or -1. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === quote) return i + 1;
    else if (c === '\n' && quote !== '`') return -1;
  }
  return -1;
}

/** Index just after the `)` matching the `(` at `open`, or -1. */
function skipParens(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, i);
      if (end === -1) return -1;
      i = end - 1;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Titles of `it(...)` / `test(...)` calls; `title` is null when it is not a string literal. */
export function testTitles(text: string): { line: number; title: string | null }[] {
  const out: { line: number; title: string | null }[] = [];
  const call = /(?<![\w$.])(?:it|test)\b((?:\s*\.\s*\w+)*)\s*([(`])/g;
  for (let m = call.exec(text); m !== null; m = call.exec(text)) {
    const line = lineOfOffset(text, m.index);
    let i = m.index + m[0].length - 1;
    if (/\.\s*(each|for)\b/.test(m[1] ?? '')) {
      // `it.each(table)('title', ...)` or it.each`table`('title', ...): skip the table first.
      i = text[i] === '(' ? skipParens(text, i) : skipString(text, i);
      if (i === -1) {
        out.push({ line, title: null });
        continue;
      }
      while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] !== '(') {
        out.push({ line, title: null });
        continue;
      }
    } else if (text[i] !== '(') {
      out.push({ line, title: null });
      continue;
    }
    i++;
    while (/\s/.test(text[i] ?? '')) i++;
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, i);
      out.push({ line, title: end === -1 ? null : text.slice(i + 1, end - 1) });
    } else {
      out.push({ line, title: null });
    }
    call.lastIndex = Math.max(call.lastIndex, i);
  }
  return out;
}

function scanTestFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const isInt = INT_TEST_FILE.test(file);
  text.split('\n').forEach((lineText, index) => {
    const line = index + 1;
    if (SKIP_OR_ONLY.test(lineText) || X_PREFIXED.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'no-skip-only',
        message: 'tests must not be skipped, focused or left as todo',
      });
    }
    const retry = RETRY_KEY.exec(lineText);
    if ((retry && !isZeroLiteral(retry[1] ?? '')) || RETRY_SHORTHAND.test(lineText)) {
      findings.push({ file, line, rule: 'no-retry', message: 'tests must not use retry' });
    }
    const references = lineText.match(ADMIN_URL)?.length ?? 0;
    if (references > (lineText.match(ADMIN_URL_ABSENT)?.length ?? 0)) {
      findings.push({
        file,
        line,
        rule: 'admin-url-only-in-global-setup',
        message: 'TEST_PG_ADMIN_URL is read only by the global setup, never by a test file',
      });
    }
    if (isInt) return;
    if (LISTEN_CALL.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'unit-no-listen',
        message: 'unit tests must not listen on a port (use Fastify inject)',
      });
    }
    IMPORT_SPECIFIER.lastIndex = 0;
    for (let m = IMPORT_SPECIFIER.exec(lineText); m !== null; m = IMPORT_SPECIFIER.exec(lineText)) {
      const specifier = m[2] ?? '';
      if (isIntegrationOnly(specifier)) {
        findings.push({
          file,
          line,
          rule: 'unit-no-db',
          message: `unit tests must not import "${specifier}" (rename the file to *.int.test.ts)`,
        });
      }
    }
  });
  return findings;
}

function scanVitestConfig(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((lineText, index) => {
    const line = index + 1;
    const retry = RETRY_KEY.exec(lineText);
    if (retry && !isZeroLiteral(retry[1] ?? '')) {
      findings.push({
        file,
        line,
        rule: 'no-retry',
        message: 'vitest config must keep retry at 0',
      });
    }
    if (PASS_WITH_NO_TESTS.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'no-pass-with-no-tests',
        message: 'passWithNoTests must stay false',
      });
    }
    if (ALLOW_ONLY.test(lineText)) {
      findings.push({ file, line, rule: 'no-skip-only', message: 'allowOnly must stay false' });
    }
  });
  return findings;
}

function scanPackageJson(file: string, text: string): Finding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [{ file, line: 1, rule: 'package-json', message: 'package.json is not valid JSON' }];
  }
  if (typeof doc !== 'object' || doc === null) return [];
  const scripts = (doc as Record<string, unknown>)['scripts'];
  if (typeof scripts !== 'object' || scripts === null) return [];
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== 'string' || !BAD_SCRIPT_FLAG.test(command)) continue;
    const at = lines.findIndex((l) => l.includes(JSON.stringify(name)));
    findings.push({
      file,
      line: at === -1 ? 1 : at + 1,
      rule: 'no-pass-with-no-tests',
      message: `script "${name}" must not use --passWithNoTests, --retry or --allowOnly`,
    });
  }
  return findings;
}

function scanRuleTestFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((lineText, index) => {
    const line = index + 1;
    if (DESCRIBE_CALL.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'rule-tests-top-level-it',
        message: 'rule tests use top-level it(), never describe() (规划/11 §4.3)',
      });
    }
    MOCK_CALL.lastIndex = 0;
    for (let m = MOCK_CALL.exec(lineText); m !== null; m = MOCK_CALL.exec(lineText)) {
      const specifier = m[2] ?? '';
      if (isFundsCoreModule(specifier)) {
        findings.push({
          file,
          line,
          rule: 'rule-tests-no-funds-mock',
          message: `rule tests must not mock "${specifier}" (规划/11 §4.3)`,
        });
      }
    }
  });
  return findings;
}

function scanAcceptanceFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const { line, title } of testTitles(text)) {
    if (title === null) {
      findings.push({
        file,
        line,
        rule: 'acceptance-title',
        message: 'acceptance test titles must be string literals carrying [AC-...]',
      });
    } else if (!AC_TAG.test(title)) {
      findings.push({
        file,
        line,
        rule: 'acceptance-title',
        message: `acceptance test title lacks an [AC-...] id: "${title}"`,
      });
    }
  }
  return findings;
}

/** Static findings for one file; `text` is its content. */
export function scanFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const isTest = TEST_FILE.test(file);
  if (isTest) findings.push(...scanTestFile(file, text));
  if (VITEST_CONFIG.test(file)) findings.push(...scanVitestConfig(file, text));
  if (file === 'package.json' || file.endsWith('/package.json')) {
    findings.push(...scanPackageJson(file, text));
  }
  if (RULE_TEST_DIR.test(file) && SCRIPT_FILE.test(file)) {
    findings.push(...scanRuleTestFile(file, text));
  }
  if (ACCEPTANCE_DIR.test(file) && isTest) findings.push(...scanAcceptanceFile(file, text));
  return findings;
}

function isRelevant(file: string): boolean {
  return (
    TEST_FILE.test(file) ||
    VITEST_CONFIG.test(file) ||
    file === 'package.json' ||
    file.endsWith('/package.json') ||
    (RULE_TEST_DIR.test(file) && SCRIPT_FILE.test(file))
  );
}

/** Runs the static checks over the given repo-relative files of the tree at `root`. */
export function scanTree(root: string, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!isRelevant(file)) continue;
    findings.push(...scanFile(file, readFileSync(join(root, file), 'utf8')));
  }
  return findings;
}

/** Class-1 rule (规划/11 §4.4): existing test assets may not be modified, deleted or renamed. */
export function addOnlyViolations(
  changes: readonly Change[],
  cfg: ProtectedConfig,
): ProtectedHit[] {
  const none = { readBase: () => null, readWork: () => null };
  return findProtectedHits(changes, cfg, none).filter((hit) => hit.class === 1);
}
