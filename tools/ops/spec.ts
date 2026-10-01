// Reads business rules from the planning repository at SPEC_REF (规划/11 §5.3).
// Planning text is only ever read through `git show <SPEC_REF>:<path>`, never
// from the working tree of the planning repository.
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { git, showFile } from '../lib/git.ts';
import { specRef, specRepo } from '../lib/paths.ts';

export type Rule = {
  id: string;
  /** Path inside the planning repository. */
  file: string;
  /** Content of the status cell (empty for acceptance cases). */
  status: string;
  /** The table row without its last (影响面) column; whole row for AC entries. */
  rowText: string;
  /** The `#### <id> 细则 · …` section up to the next heading; '' when absent. */
  detailText: string;
};

/** Where planning text comes from; tests inject synthetic sources. */
export type SpecSource = {
  list(dir: string): string[];
  read(path: string): string;
};

export const RULES_DIR = '规划/08_业务规则';
export const ACCEPTANCE_FILE = '规划/10_首个完整流程验收用例.md';
export const REQUIREMENTS_FILE = '规划/01_需求规划.md';
export const TASKS_FILE = '规划/05_里程碑与任务拆分.md';

const RULE_TABLE_HEADER = ['编号', '规则', '状态', '影响面'];
const BR_ID = /^BR-[A-Z]+-[0-9]+[a-z]?$/;
const AC_STAGE_ID = /^AC-S[0-9]+-[0-9]+[a-z]?(-[A-Z]+)?$/;
const AC_EPIC_ID = /^AC-([A-Z]+)-([0-9]+)$/;

export function isRuleId(id: string): boolean {
  return BR_ID.test(id);
}

export function isAcceptanceId(id: string): boolean {
  return AC_STAGE_ID.test(id) || AC_EPIC_ID.test(id);
}

/** Planning repository at SPEC_REF, cached per process. */
export function gitSpecSource(repo: string = specRepo(), ref: string = specRef()): SpecSource {
  if (!existsSync(repo)) {
    throw new Error(
      `planning repository not found at ${repo} (set COULI_SPEC_REPO, default <REPO>/../couli)`,
    );
  }
  const texts = new Map<string, string>();
  const lists = new Map<string, string[]>();
  return {
    list(dir) {
      let hit = lists.get(dir);
      if (!hit) {
        const out = git(
          [
            '-c',
            'core.quotepath=false',
            'ls-tree',
            '-r',
            '-z',
            '--name-only',
            ref,
            '--',
            `${dir}/`,
          ],
          { cwd: repo },
        );
        hit = out
          .split('\0')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .sort();
        lists.set(dir, hit);
      }
      return hit;
    },
    read(path) {
      let hit = texts.get(path);
      if (hit === undefined) {
        hit = showFile(repo, ref, path);
        texts.set(path, hit);
      }
      return hit;
    },
  };
}

let defaultSource: SpecSource | undefined;
function source(src?: SpecSource): SpecSource {
  if (src) return src;
  defaultSource ??= gitSpecSource();
  return defaultSource;
}

/**
 * Splits one Markdown table row into raw cells. A pipe preceded by a backslash
 * is cell content, not a separator (规划/11 §5.3). Cells keep their original
 * text, including the escape, so excerpts stay verbatim.
 */
export function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.length < 2) return null;
  const cells: string[] = [];
  let cur = '';
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\' && i + 1 < trimmed.length) {
      cur += ch + trimmed[i + 1];
      i += 1;
    } else if (ch === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  // A trailing `\|` means the row never closed its last cell.
  if (cur.length > 0) return null;
  return cells;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => /^\s*:?-{3,}:?\s*$/.test(c));
}

type TableRow = { cells: string[]; header: string[] };

/** Every data row of every table in a Markdown document, with its header. */
export function tableRows(text: string): TableRow[] {
  const rows: TableRow[] = [];
  let header: string[] | null = null;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      header = null;
      continue;
    }
    if (inFence) continue;
    const cells = splitTableRow(line);
    if (!cells) {
      header = null;
      continue;
    }
    if (!header) {
      header = cells.map((c) => c.trim());
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    rows.push({ cells, header });
  }
  return rows;
}

function rowWithoutLastCell(cells: string[]): string {
  return `|${cells.slice(0, -1).join('|')}|`;
}

/** The 细则 section of a rule: from its `####` heading to the next heading of level <= 4. */
export function extractDetail(text: string, id: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`#### ${id} 细则`));
  if (start < 0) return '';
  let end = lines.length;
  let inFence = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^#{1,4} /.test(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

/** Looks a BR entry up in one rule file; null when the file does not define it. */
export function findRuleInText(text: string, id: string, file: string): Rule | null {
  for (const row of tableRows(text)) {
    if (row.header.length !== RULE_TABLE_HEADER.length) continue;
    if (!row.header.every((h, i) => h === RULE_TABLE_HEADER[i])) continue;
    if (row.cells.length !== RULE_TABLE_HEADER.length) {
      if ((row.cells[0] ?? '').trim() === id) {
        throw new Error(
          `${file}: row ${id} has ${row.cells.length} cells, expected ${RULE_TABLE_HEADER.length} (unescaped pipe?)`,
        );
      }
      continue;
    }
    if ((row.cells[0] ?? '').trim() !== id) continue;
    return {
      id,
      file,
      status: (row.cells[2] ?? '').trim(),
      rowText: rowWithoutLastCell(row.cells),
      detailText: extractDetail(text, id),
    };
  }
  return null;
}

function findRowByFirstCell(text: string, firstCell: string): string[] | null {
  for (const row of tableRows(text)) {
    if ((row.cells[0] ?? '').trim() === firstCell) return row.cells;
  }
  return null;
}

/**
 * Resolves a `refs` entry of a task file:
 * - `BR-XXX-nn`: rule table row + 细则 in 规划/08_业务规则/;
 * - `AC-S<stage>-<nn>[-TB|-JD|-PDD]`: the case row in 规划/10;
 * - `AC-<EPIC>-<nn>`: shares its number with `F-<EPIC>-<nn>` in 规划/01 §6 (规划/10 §0.5).
 * Throws when the id is unknown at SPEC_REF.
 */
export function findRule(id: string, src?: SpecSource): Rule {
  const s = source(src);
  if (BR_ID.test(id)) {
    const prefix = id.slice(0, id.lastIndexOf('-') + 1);
    for (const file of s.list(RULES_DIR)) {
      if (!file.endsWith('.md')) continue;
      const text = s.read(file);
      if (!text.includes(`| ${prefix}`)) continue;
      const rule = findRuleInText(text, id, file);
      if (rule) return rule;
    }
    throw new Error(`${id}: not found in ${RULES_DIR} at SPEC_REF`);
  }
  if (AC_STAGE_ID.test(id)) {
    const cells = findRowByFirstCell(s.read(ACCEPTANCE_FILE), id);
    if (!cells) throw new Error(`${id}: not found in ${ACCEPTANCE_FILE} at SPEC_REF`);
    return {
      id,
      file: ACCEPTANCE_FILE,
      status: '',
      rowText: `|${cells.join('|')}|`,
      detailText: '',
    };
  }
  const epic = AC_EPIC_ID.exec(id);
  if (epic) {
    const featureId = `F-${epic[1]}-${epic[2]}`;
    const cells = findRowByFirstCell(s.read(REQUIREMENTS_FILE), featureId);
    if (!cells) {
      throw new Error(`${id}: ${featureId} not found in ${REQUIREMENTS_FILE} at SPEC_REF`);
    }
    return {
      id,
      file: REQUIREMENTS_FILE,
      status: '',
      rowText: `|${cells.join('|')}|`,
      detailText: '',
    };
  }
  throw new Error(`${id}: unsupported reference (expected BR-… or AC-…)`);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Row text without the status cell (rules only; AC rows have no status cell). */
function rowBody(rule: Rule): string {
  if (!BR_ID.test(rule.id)) return rule.rowText;
  const cells = splitTableRow(rule.rowText);
  if (!cells || cells.length !== 3) throw new Error(`${rule.id}: malformed rowText`);
  return `|${cells.slice(0, 2).join('|')}|`;
}

/**
 * The status of a rule is also repeated as the `- 状态：` bullet at the top of
 * its 细则 section. That bullet is left out of the hash together with the
 * status cell, so that a status-only change (默认假设 -> 已确认) does not mark
 * tasks stale (规划/11 §5.3).
 */
function detailBody(detail: string): string {
  const lines = detail.split('\n');
  // Only the bullet list right under the heading is metadata.
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('-')) break;
    if (/^-\s*状态：/.test(trimmed)) {
      lines.splice(i, 1);
      break;
    }
  }
  return lines.join('\n');
}

/** First 12 hex digits of sha256 over the normalized body of the entry. */
export function ruleHash(rule: Rule): string {
  const body = `${normalize(rowBody(rule))}\n${normalize(detailBody(rule.detailText))}`;
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Other BR ids mentioned by a rule, in order of first appearance. Understands
 * the short forms used in 08: `BR-FUND-10、11、13`, `BR-WDR-14/15/17` and the
 * range `BR-CALC-05～08`. A bare `BR-FUND` (topic reference) is ignored.
 */
export function oneHopRefs(rule: Rule): string[] {
  const text = `${rule.rowText}\n${rule.detailText}`;
  const found: string[] = [];
  const add = (id: string): void => {
    if (id !== rule.id && !found.includes(id)) found.push(id);
  };
  const re = /BR-([A-Z]+)-([0-9]+[a-z]?)((?:\s*[、/～]\s*[0-9]+[a-z]?(?![0-9]*[-A-Za-z]))*)/g;
  for (const m of text.matchAll(re)) {
    const topic = m[1] ?? '';
    let last = m[2] ?? '';
    add(`BR-${topic}-${last}`);
    const width = last.replace(/[a-z]$/, '').length;
    for (const part of (m[3] ?? '').matchAll(/([、/～])\s*([0-9]+[a-z]?)/g)) {
      const sep = part[1];
      const num = part[2] ?? '';
      // `BR-CALC-02、3 个` is prose, not a list of ids: numbers keep the id width.
      if (num.replace(/[a-z]$/, '').length !== width) break;
      if (sep === '～') {
        const from = Number.parseInt(last, 10);
        const to = Number.parseInt(num, 10);
        if (to > from && to - from <= 30) {
          for (let n = from + 1; n < to; n += 1) {
            add(`BR-${topic}-${String(n).padStart(width, '0')}`);
          }
        }
      }
      add(`BR-${topic}-${num}`);
      last = num;
    }
  }
  return found;
}

/** True when a task id (without its split suffix) is a row of a task table in 规划/05. */
export function taskIdKnown(idPrefix: string, src?: SpecSource): boolean {
  return findRowByFirstCell(source(src).read(TASKS_FILE), idPrefix) !== null;
}
