// Agent eval framework, part 1 (B3-01a): eval case and manifest shapes, JSONL loading and the
// set-level checks (manifest hashes, split leak, near duplicates, append-only, smoke composition).
// Only loaders, schemas and synthetic samples live in this public repository; the real eval sets,
// prompts and recordings stay in private storage (BR-AI-21, BR-AI-19).
// The JSON Schemas in ../schema/ describe the same shapes as validateCase / validateManifest.
import { createHash } from 'node:crypto';

export type EvalSet = 'smoke' | 'find' | 'badcase' | 'baseline-pairs' | 'judges';
export type Category =
  | 'T1'
  | 'T2'
  | 'T3'
  | 'T4'
  | 'T5'
  | 'T6'
  | 'injection'
  | 'unauthorized'
  | 'identity_arg'
  | 'banned'
  | 'promise_bait'
  | 'unverified_cap'
  | 'boundary_normal'
  | 'chitchat';
export type Split = 'tune' | 'validate' | 'holdout';
export type Provenance =
  'synthetic' | 'vendor_synthetic' | 'aggregated_stats' | 'rewritten' | 'real_link_sample';
export type Subject = 'guest' | 'logged_in' | 'bound_phone';
export type Intent =
  | 'find_by_link'
  | 'search'
  | 'refine'
  | 'order_query'
  | 'rule_qa'
  | 'handoff'
  | 'clarify'
  | 'out_of_scope'
  | 'page_guide'
  | 'earnings_query';
export type Forbid =
  'amount_in_text' | 'url_in_text' | 'identity_arg' | 'banned_word_in_text' | 'auto_redirect';

export interface EvalCase {
  id: string;
  set: EvalSet;
  category: Category;
  split: Split;
  group: string;
  provenance: Provenance;
  source_ref?: string;
  subject: Subject;
  switches?: Record<string, boolean>;
  turns: { text: string; untrusted?: boolean }[];
  expect: {
    intent: Intent;
    tools?: { name: string; args?: Record<string, unknown> }[];
    cards?: string[];
    forbid?: Forbid[];
  };
  retired?: { at: string; reason: string };
}

export interface Manifest {
  set: EvalSet;
  version: string;
  count: number;
  by_category: Partial<Record<Category, number>>;
  content_sha256: string;
  split_sha256: string;
}

export interface Problem {
  code: string;
  id?: string;
  file?: string;
  line?: number;
  message: string;
}

// ---------------------------------------------------------------------------------------------
// Enumerations (kept in the same order as the JSON Schemas).

export const EVAL_SETS: readonly EvalSet[] = [
  'smoke',
  'find',
  'badcase',
  'baseline-pairs',
  'judges',
];
export const CATEGORIES: readonly Category[] = [
  'T1',
  'T2',
  'T3',
  'T4',
  'T5',
  'T6',
  'injection',
  'unauthorized',
  'identity_arg',
  'banned',
  'promise_bait',
  'unverified_cap',
  'boundary_normal',
  'chitchat',
];
export const SPLITS: readonly Split[] = ['tune', 'validate', 'holdout'];
export const PROVENANCES: readonly Provenance[] = [
  'synthetic',
  'vendor_synthetic',
  'aggregated_stats',
  'rewritten',
  'real_link_sample',
];
export const SUBJECTS: readonly Subject[] = ['guest', 'logged_in', 'bound_phone'];
export const INTENTS: readonly Intent[] = [
  'find_by_link',
  'search',
  'refine',
  'order_query',
  'rule_qa',
  'handoff',
  'clarify',
  'out_of_scope',
  'page_guide',
  'earnings_query',
];
export const FORBIDS: readonly Forbid[] = [
  'amount_in_text',
  'url_in_text',
  'identity_arg',
  'banned_word_in_text',
  'auto_redirect',
];

/** BR-AI-21: smoke set composition (active cases only). */
export const SMOKE_MIN_TOTAL = 30;
export const SMOKE_MIN_PER_CATEGORY = 3;
export const SMOKE_REQUIRED_CATEGORIES: readonly Category[] = [
  'T1',
  'T2',
  'T3',
  'T4',
  'T5',
  'T6',
  'injection',
  'unauthorized',
];

const ID_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------------
// Structural validation.

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (isObject(value)) return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  return false;
}

function isCalendarDate(text: string): boolean {
  const match = DATE_PATTERN.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

class Collector {
  readonly problems: Problem[] = [];
  private readonly id: string | undefined;

  constructor(id: string | undefined) {
    this.id = id;
  }

  add(path: string, message: string): void {
    const problem: Problem = { code: 'schema', message: `${path || '/'}: ${message}` };
    if (this.id !== undefined) problem.id = this.id;
    this.problems.push(problem);
  }

  /** Reports missing required keys and keys outside `allowed`; returns false if not an object. */
  object(
    value: unknown,
    path: string,
    required: string[],
    optional: string[],
  ): value is JsonObject {
    if (!isObject(value)) {
      this.add(path, 'must be an object');
      return false;
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key)) this.add(path, `missing required property "${key}"`);
    }
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) this.add(path, `unexpected property "${key}"`);
    }
    return true;
  }

  string(value: unknown, path: string, opts: { minLength?: number } = {}): void {
    if (typeof value !== 'string') {
      this.add(path, 'must be a string');
    } else if (value.length < (opts.minLength ?? 0)) {
      this.add(path, `must have at least ${opts.minLength} characters`);
    }
  }

  boolean(value: unknown, path: string): void {
    if (typeof value !== 'boolean') this.add(path, 'must be a boolean');
  }

  oneOf(value: unknown, path: string, allowed: readonly string[]): void {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      this.add(path, `must be one of ${allowed.join(', ')}`);
    }
  }

  array(value: unknown, path: string, each: (item: unknown, path: string) => void): void {
    if (!Array.isArray(value)) {
      this.add(path, 'must be an array');
      return;
    }
    value.forEach((item, index) => each(item, `${path}/${index}`));
  }
}

function present(value: JsonObject, key: string): boolean {
  return Object.hasOwn(value, key);
}

/** Strict structural check of one eval case; `[]` when valid. Every problem has code `schema`. */
export function validateCase(value: unknown): Problem[] {
  const caseId =
    isObject(value) && typeof value['id'] === 'string' ? (value['id'] as string) : undefined;
  const c = new Collector(caseId);
  if (
    !c.object(
      value,
      '',
      ['id', 'set', 'category', 'split', 'group', 'provenance', 'subject', 'turns', 'expect'],
      ['source_ref', 'switches', 'retired'],
    )
  ) {
    return c.problems;
  }

  if (present(value, 'id')) {
    const id = value['id'];
    if (typeof id !== 'string') c.add('/id', 'must be a string');
    else if (!ID_PATTERN.test(id)) c.add('/id', `must match ${ID_PATTERN.source}`);
  }
  if (present(value, 'set')) c.oneOf(value['set'], '/set', EVAL_SETS);
  if (present(value, 'category')) c.oneOf(value['category'], '/category', CATEGORIES);
  if (present(value, 'split')) c.oneOf(value['split'], '/split', SPLITS);
  if (present(value, 'group')) c.string(value['group'], '/group', { minLength: 1 });
  if (present(value, 'provenance')) c.oneOf(value['provenance'], '/provenance', PROVENANCES);
  if (present(value, 'source_ref')) c.string(value['source_ref'], '/source_ref', { minLength: 1 });
  if (present(value, 'subject')) c.oneOf(value['subject'], '/subject', SUBJECTS);

  if (present(value, 'switches')) {
    const switches = value['switches'];
    if (!isObject(switches)) c.add('/switches', 'must be an object');
    else {
      for (const [key, flag] of Object.entries(switches)) c.boolean(flag, `/switches/${key}`);
    }
  }

  if (present(value, 'turns')) {
    const turns = value['turns'];
    if (Array.isArray(turns) && turns.length === 0) c.add('/turns', 'must have at least 1 item');
    c.array(turns, '/turns', (turn, path) => {
      if (!c.object(turn, path, ['text'], ['untrusted'])) return;
      if (present(turn, 'text')) c.string(turn['text'], `${path}/text`, { minLength: 1 });
      if (present(turn, 'untrusted')) c.boolean(turn['untrusted'], `${path}/untrusted`);
    });
  }

  if (present(value, 'expect')) {
    const exp = value['expect'];
    if (c.object(exp, '/expect', ['intent'], ['tools', 'cards', 'forbid'])) {
      if (present(exp, 'intent')) c.oneOf(exp['intent'], '/expect/intent', INTENTS);
      if (present(exp, 'tools')) {
        c.array(exp['tools'], '/expect/tools', (tool, path) => {
          if (!c.object(tool, path, ['name'], ['args'])) return;
          if (present(tool, 'name')) c.string(tool['name'], `${path}/name`, { minLength: 1 });
          if (present(tool, 'args')) {
            const args = tool['args'];
            if (!isObject(args)) c.add(`${path}/args`, 'must be an object');
            else if (!isJsonValue(args)) c.add(`${path}/args`, 'must contain only JSON values');
          }
        });
      }
      if (present(exp, 'cards')) {
        c.array(exp['cards'], '/expect/cards', (card, path) =>
          c.string(card, path, { minLength: 1 }),
        );
      }
      if (present(exp, 'forbid')) {
        c.array(exp['forbid'], '/expect/forbid', (item, path) => c.oneOf(item, path, FORBIDS));
      }
    }
  }

  if (present(value, 'retired')) {
    const retired = value['retired'];
    if (c.object(retired, '/retired', ['at', 'reason'], [])) {
      if (present(retired, 'at')) {
        const at = retired['at'];
        if (typeof at !== 'string') c.add('/retired/at', 'must be a string');
        else if (!isCalendarDate(at)) c.add('/retired/at', 'must be a date YYYY-MM-DD');
      }
      if (present(retired, 'reason')) {
        c.string(retired['reason'], '/retired/reason', { minLength: 1 });
      }
    }
  }

  return c.problems;
}

/** Strict structural check of a manifest; `[]` when valid. Every problem has code `schema`. */
export function validateManifest(value: unknown): Problem[] {
  const c = new Collector(undefined);
  const keys = ['set', 'version', 'count', 'by_category', 'content_sha256', 'split_sha256'];
  if (!c.object(value, '', keys, [])) return c.problems;
  if (present(value, 'set')) c.oneOf(value['set'], '/set', EVAL_SETS);
  if (present(value, 'version')) c.string(value['version'], '/version', { minLength: 1 });
  if (present(value, 'count')) {
    const count = value['count'];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      c.add('/count', 'must be a non-negative integer');
    }
  }
  if (present(value, 'by_category')) {
    const byCategory = value['by_category'];
    if (!isObject(byCategory)) c.add('/by_category', 'must be an object');
    else {
      for (const [key, count] of Object.entries(byCategory)) {
        if (!(CATEGORIES as readonly string[]).includes(key)) {
          c.add('/by_category', `unexpected property "${key}"`);
        } else if (!Number.isSafeInteger(count) || (count as number) < 1) {
          c.add(`/by_category/${key}`, 'must be a positive integer');
        }
      }
    }
  }
  for (const key of ['content_sha256', 'split_sha256']) {
    if (!present(value, key)) continue;
    const digest = value[key];
    if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest)) {
      c.add(`/${key}`, 'must be a lowercase hex SHA-256');
    }
  }
  return c.problems;
}

// ---------------------------------------------------------------------------------------------
// JSONL loading.

/**
 * Parses JSONL eval cases. Blank lines are skipped; `line` is the 1-based physical line number.
 * Lines that fail JSON parsing or validation are reported and skipped; later lines still load.
 * A repeated id (retired or not) is reported as `duplicate_id` and the later line is skipped.
 */
export function parseJsonl(text: string, file: string): { cases: EvalCase[]; problems: Problem[] } {
  const cases: EvalCase[] = [];
  const problems: Problem[] = [];
  const firstLine = new Map<string, number>();
  const lines = text.split('\n');
  lines.forEach((raw, index) => {
    const line = index + 1;
    const source = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (source.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      problems.push({ code: 'json', file, line, message: `invalid JSON: ${reason}` });
      return;
    }
    const found = validateCase(value);
    if (found.length > 0) {
      for (const problem of found) problems.push({ ...problem, file, line });
      return;
    }
    const item = value as EvalCase;
    const previous = firstLine.get(item.id);
    if (previous !== undefined) {
      problems.push({
        code: 'duplicate_id',
        id: item.id,
        file,
        line,
        message: `id "${item.id}" already used on line ${previous}`,
      });
      return;
    }
    firstLine.set(item.id, line);
    cases.push(item);
  });
  return { cases, problems };
}

// ---------------------------------------------------------------------------------------------
// Canonical JSON and manifest.

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical compact JSON: object keys sorted by UTF-16 code units at every level, array order
 * kept, `undefined` members dropped (as JSON.stringify does). Built by hand so that integer-like
 * keys are not moved to the front by JavaScript's own property order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item: unknown) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
      }
      const record = value as JsonObject;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort(compareCodeUnits);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sortById(cases: readonly EvalCase[]): EvalCase[] {
  return [...cases].sort((a, b) => compareCodeUnits(a.id, b.id));
}

function isActive(item: EvalCase): boolean {
  return item.retired === undefined;
}

/**
 * Manifest of one set version. `count` / `by_category` cover active cases only; both digests
 * cover every case including retired ones:
 *   content_sha256 = sha256(concat over cases by id of canonicalJson(case) + "\n")
 *   split_sha256   = sha256(concat over cases by id of id + "\t" + split + "\n")
 * Ids are ordered by UTF-16 code units; the result does not depend on input order.
 */
export function computeManifest(set: EvalSet, version: string, cases: EvalCase[]): Manifest {
  const sorted = sortById(cases);
  const counts = new Map<Category, number>();
  let count = 0;
  for (const item of sorted) {
    if (!isActive(item)) continue;
    count += 1;
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  const byCategory: Partial<Record<Category, number>> = {};
  for (const category of CATEGORIES) {
    const n = counts.get(category);
    if (n !== undefined) byCategory[category] = n;
  }
  return {
    set,
    version,
    count,
    by_category: byCategory,
    content_sha256: sha256Hex(sorted.map((item) => `${canonicalJson(item)}\n`).join('')),
    split_sha256: sha256Hex(sorted.map((item) => `${item.id}\t${item.split}\n`).join('')),
  };
}

/** Recomputes the manifest from `cases` and reports every differing field as `manifest_mismatch`. */
export function checkManifest(manifest: Manifest, cases: EvalCase[]): Problem[] {
  const problems: Problem[] = [];
  const expected = computeManifest(manifest.set, manifest.version, cases);
  const fields = ['count', 'by_category', 'content_sha256', 'split_sha256'] as const;
  for (const field of fields) {
    const actual = canonicalJson(manifest[field]);
    const wanted = canonicalJson(expected[field]);
    if (actual !== wanted) {
      problems.push({
        code: 'manifest_mismatch',
        message: `${field}: manifest has ${actual}, cases give ${wanted}`,
      });
    }
  }
  for (const item of sortById(cases)) {
    if (item.set !== manifest.set) {
      problems.push({
        code: 'manifest_mismatch',
        id: item.id,
        message: `set: manifest is "${manifest.set}" but case "${item.id}" has set "${item.set}"`,
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Set-level checks.

/** A group (scenario template or conversation) must stay in one split; active cases only. */
export function checkSplitLeak(cases: EvalCase[]): Problem[] {
  const groups = new Map<string, Map<Split, string[]>>();
  for (const item of sortById(cases)) {
    if (!isActive(item)) continue;
    let splits = groups.get(item.group);
    if (!splits) {
      splits = new Map();
      groups.set(item.group, splits);
    }
    const ids = splits.get(item.split) ?? [];
    ids.push(item.id);
    splits.set(item.split, ids);
  }
  const problems: Problem[] = [];
  for (const group of [...groups.keys()].sort(compareCodeUnits)) {
    const splits = groups.get(group);
    if (!splits || splits.size < 2) continue;
    const detail = SPLITS.filter((split) => splits.has(split))
      .map((split) => `${split}: ${(splits.get(split) ?? []).join(', ')}`)
      .join('; ');
    const firstId = SPLITS.flatMap((split) => splits.get(split) ?? [])[0];
    const problem: Problem = {
      code: 'split_leak',
      message: `group "${group}" appears in more than one split (${detail})`,
    };
    if (firstId !== undefined) problem.id = firstId;
    problems.push(problem);
  }
  return problems;
}

/** Text used for near-duplicate detection: all turns joined, NFKC, lower case, no whitespace or
 * Unicode punctuation (symbols such as "+" are kept). */
export function normalizeTurns(item: EvalCase): string {
  const joined = item.turns.map((turn) => turn.text).join('');
  return joined
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{White_Space}\p{P}]/gu, '');
}

/** Different active ids whose normalized turn text is identical are `near_duplicate`. */
export function checkNearDuplicates(cases: EvalCase[]): Problem[] {
  const byText = new Map<string, string[]>();
  for (const item of sortById(cases)) {
    if (!isActive(item)) continue;
    const key = normalizeTurns(item);
    const ids = byText.get(key) ?? [];
    if (!ids.includes(item.id)) ids.push(item.id);
    byText.set(key, ids);
  }
  const problems: Problem[] = [];
  for (const ids of byText.values()) {
    const [first, ...rest] = ids;
    if (first === undefined) continue;
    for (const other of rest) {
      problems.push({
        code: 'near_duplicate',
        id: other,
        message: `case "${other}" has the same normalized text as "${first}"`,
      });
    }
  }
  return problems;
}

/**
 * Append-only or retire: every previous id must remain; a retired case cannot be un-retired; a
 * changed `expect` (compared as canonical JSON) needs an entry in `changes` with a reason.
 */
export function checkAppendOnly(
  prev: EvalCase[],
  next: EvalCase[],
  changes?: { id: string; reason: string }[],
): Problem[] {
  const nextById = new Map(next.map((item) => [item.id, item]));
  const recorded = new Set(
    (changes ?? []).filter((change) => change.reason.trim() !== '').map((change) => change.id),
  );
  const problems: Problem[] = [];
  for (const before of sortById(prev)) {
    const after = nextById.get(before.id);
    if (!after) {
      problems.push({
        code: 'removed',
        id: before.id,
        message: `case "${before.id}" was removed; cases may only be added or retired`,
      });
      continue;
    }
    if (before.retired !== undefined && after.retired === undefined) {
      problems.push({
        code: 'unretired',
        id: before.id,
        message: `case "${before.id}" was retired on ${before.retired.at} and cannot be restored`,
      });
    }
    if (canonicalJson(before.expect) !== canonicalJson(after.expect) && !recorded.has(before.id)) {
      problems.push({
        code: 'expect_changed',
        id: before.id,
        message: `expect of case "${before.id}" changed without a change record`,
      });
    }
  }
  return problems;
}

/**
 * Smoke set composition (BR-AI-21): at least 30 active cases, and at least 3 active cases in each
 * of T1–T6, injection and unauthorized. Each shortfall is reported separately.
 */
export function checkSmokeComposition(cases: EvalCase[]): Problem[] {
  const active = cases.filter(isActive);
  const problems: Problem[] = [];
  if (active.length < SMOKE_MIN_TOTAL) {
    problems.push({
      code: 'smoke_composition',
      message: `总数：未退役 ${active.length} 条，BR-AI-21 要求至少 ${SMOKE_MIN_TOTAL} 条，差 ${SMOKE_MIN_TOTAL - active.length} 条`,
    });
  }
  for (const category of SMOKE_REQUIRED_CATEGORIES) {
    const n = active.filter((item) => item.category === category).length;
    if (n < SMOKE_MIN_PER_CATEGORY) {
      problems.push({
        code: 'smoke_composition',
        message: `类别 ${category}：未退役 ${n} 条，BR-AI-21 要求至少 ${SMOKE_MIN_PER_CATEGORY} 条，差 ${SMOKE_MIN_PER_CATEGORY - n} 条`,
      });
    }
  }
  return problems;
}
