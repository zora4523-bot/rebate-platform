// Checks specs/fund-term-keys.yaml, the fund term key list (规划/08 BR-TEXT-12 细则「资金术语键」;
// admin permission content.fund_terms, 04 §11.2). Run by codegen.ts in both modes, so
// `pnpm contracts:check` fails on a violation. The syntax is documented in the file.
//
// Every key of contracts/texts.default.json and every notify_template_code value must fall in
// exactly one of the two segments (fund_terms, ordinary); an ordinary text that hits the keyword
// cross-check needs an exempt entry with a reason.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import type { EnumDef } from './catalog.ts';
import { repoRoot } from './paths.ts';
import { TEXT_KEY, textsFile } from './texts.ts';

export const fundTermKeysFile = join(repoRoot, 'specs', 'fund-term-keys.yaml');

export const SEGMENTS = ['fund_terms', 'ordinary'] as const;
export type Segment = (typeof SEGMENTS)[number];
export type SegmentDef = { prefixes: string[]; keys: string[]; notify_templates: string[] };
export type FundTermKeys = Record<Segment, SegmentDef> & {
  exempt: Array<{ key: string; reason: string }>;
};

/** ④: placeholders that carry an amount formatted by BR-TEXT-10. */
export const AMOUNT_PLACEHOLDERS = [
  'amount',
  'rebate',
  'rebate_sum',
  'sum',
  'promo_sum',
  'net',
  'fee',
  'tax',
  'max',
];
/** ⑤: the 「用户词」 column of the BR-TEXT-01 term table. */
export const USER_TERMS = [
  '预估返',
  '预估返利',
  '预估推广收益',
  '预估收益',
  '已结算',
  '实返',
  '推广收益',
  '可提现',
  '可提现余额',
  '待抵扣',
  '冻结中',
  '已到账',
  '已提现',
  '实际到账',
  '跟单成功',
  '已失效',
  '已扣回',
];
/** The keyword list of the cross-check. */
export const KEYWORDS = [
  '返利',
  '收益',
  '提现',
  '到账',
  '余额',
  '冻结',
  '扣回',
  '结算',
  '入账',
  '抵扣',
];

const PREFIX = /^[a-z][a-z0-9_]*(\.[A-Za-z0-9_]+)*\.?$/;
const TEMPLATE_CODE = /^[A-Z][A-Z0-9_]*$/;
const LISTS = ['prefixes', 'keys', 'notify_templates'] as const;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What makes a text hit the keyword cross-check; empty when it does not. */
export function keywordHits(text: string): string[] {
  const vars = [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] ?? '');
  return [
    ...vars.filter((v) => AMOUNT_PLACEHOLDERS.includes(v)).map((v) => `{${v}}`),
    ...USER_TERMS.filter((w) => text.includes(w)),
    ...KEYWORDS.filter((w) => text.includes(w)),
  ];
}

/** The segments whose prefix or listed key covers a text key. */
export function segmentsOfKey(doc: FundTermKeys, key: string): Segment[] {
  return SEGMENTS.filter(
    (s) => doc[s].keys.includes(key) || doc[s].prefixes.some((p) => key.startsWith(p)),
  );
}

/** The segments that list a notify template code. */
export function segmentsOfTemplate(doc: FundTermKeys, code: string): Segment[] {
  return SEGMENTS.filter((s) => doc[s].notify_templates.includes(code));
}

/**
 * The guard's decision for one key: a key the list does not classify counts as a fund term
 * (08: 清单里查不到的键或模板按资金术语处理).
 */
export function isFundTermKey(doc: FundTermKeys, key: string): boolean {
  const segs = segmentsOfKey(doc, key);
  return segs.length !== 1 || segs[0] === 'fund_terms';
}

export function loadFundTermKeys(file: string = fundTermKeysFile): unknown {
  return parseYamlLite(readFileSync(file, 'utf8'));
}

/** Structure of the parsed file; returns the typed document only when it is well-formed. */
function checkShape(doc: unknown, where: string, problems: string[]): FundTermKeys | null {
  if (!isObj(doc)) {
    problems.push(`${where}: top level must be a mapping`);
    return null;
  }
  const extra = Object.keys(doc).filter((k) => ![...SEGMENTS, 'exempt'].includes(k));
  if (extra.length > 0) problems.push(`${where}: unknown top-level keys ${extra.join(', ')}`);
  const start = problems.length;
  for (const seg of SEGMENTS) {
    const s = doc[seg];
    if (!isObj(s)) {
      problems.push(`${where}: ${seg} must be a mapping`);
      continue;
    }
    const sx = Object.keys(s).filter((k) => !(LISTS as readonly string[]).includes(k));
    if (sx.length > 0) problems.push(`${where}: ${seg}: unknown keys ${sx.join(', ')}`);
    for (const list of LISTS) {
      const v = s[list];
      if (!Array.isArray(v)) {
        problems.push(`${where}: ${seg}.${list} must be a list`);
        continue;
      }
      const re = list === 'prefixes' ? PREFIX : list === 'keys' ? TEXT_KEY : TEMPLATE_CODE;
      v.forEach((item, i) => {
        if (typeof item !== 'string' || !re.test(item)) {
          problems.push(
            `${where}: ${seg}.${list}[${String(i)}] ${JSON.stringify(item)} is malformed`,
          );
        } else if (v.indexOf(item) !== i) {
          problems.push(`${where}: ${seg}.${list}: duplicate ${item}`);
        }
      });
    }
  }
  const exempt = doc['exempt'];
  if (!Array.isArray(exempt)) {
    problems.push(`${where}: exempt must be a list`);
  } else {
    exempt.forEach((e, i) => {
      const at = `${where}: exempt[${String(i)}]`;
      if (!isObj(e)) {
        problems.push(`${at}: must be a mapping {key, reason}`);
        return;
      }
      const ex = Object.keys(e).filter((k) => k !== 'key' && k !== 'reason');
      if (ex.length > 0) problems.push(`${at}: unknown keys ${ex.join(', ')}`);
      if (typeof e['key'] !== 'string' || !TEXT_KEY.test(e['key'])) {
        problems.push(`${at}: key must be a text key`);
      }
      if (typeof e['reason'] !== 'string' || e['reason'].trim() === '') {
        problems.push(`${at}: reason must be a non-empty string`);
      }
    });
  }
  return problems.length === start ? (doc as unknown as FundTermKeys) : null;
}

/** Checks the list itself, then classifies the given texts and notify template codes. */
export function checkFundTermDoc(
  raw: unknown,
  texts: Record<string, string>,
  templateCodes: readonly string[],
  where = 'specs/fund-term-keys.yaml',
): string[] {
  const problems: string[] = [];
  const doc = checkShape(raw, where, problems);
  if (doc === null) return problems;
  const [a, b] = SEGMENTS;

  // The two segments must not be able to cover the same key.
  for (const p of doc[a].prefixes) {
    for (const q of doc[b].prefixes) {
      if (p.startsWith(q) || q.startsWith(p)) {
        problems.push(`${where}: prefix ${p} (${a}) and ${q} (${b}) overlap`);
      }
    }
  }
  for (const seg of SEGMENTS) {
    for (const key of doc[seg].keys) {
      const segs = segmentsOfKey(doc, key);
      if (segs.length > 1)
        problems.push(`${where}: ${seg}.keys: ${key} is covered by both segments`);
      else if (doc[seg].prefixes.some((p) => key.startsWith(p))) {
        problems.push(`${where}: ${seg}.keys: ${key} is already covered by a prefix of ${seg}`);
      }
    }
  }

  // Notify templates: each enum code in exactly one segment, nothing outside the enum.
  for (const seg of SEGMENTS) {
    for (const code of doc[seg].notify_templates) {
      if (!templateCodes.includes(code)) {
        problems.push(`${where}: ${seg}.notify_templates: ${code} is not a notify_template_code`);
      }
    }
  }
  for (const code of templateCodes) {
    const segs = segmentsOfTemplate(doc, code);
    if (segs.length === 0) problems.push(`${where}: notify template ${code} is not classified`);
    if (segs.length > 1) problems.push(`${where}: notify template ${code} is in both segments`);
  }

  // Text keys: each in exactly one segment.
  for (const key of Object.keys(texts)) {
    const segs = segmentsOfKey(doc, key);
    if (segs.length === 0) problems.push(`${where}: text key ${key} is not classified`);
    if (segs.length > 1) problems.push(`${where}: text key ${key} is in both segments`);
  }

  // Exempt table: exactly the ordinary texts that hit the keyword cross-check.
  const exempted = new Set<string>();
  for (const { key } of doc.exempt) {
    if (exempted.has(key)) problems.push(`${where}: exempt: duplicate ${key}`);
    exempted.add(key);
    const text = texts[key];
    const segs = segmentsOfKey(doc, key);
    if (text === undefined) problems.push(`${where}: exempt: ${key} is not a text key`);
    else if (segs.length !== 1 || segs[0] !== 'ordinary') {
      problems.push(`${where}: exempt: ${key} is not classified ordinary`);
    } else if (keywordHits(text).length === 0) {
      problems.push(`${where}: exempt: ${key} does not hit the keyword cross-check, remove it`);
    }
  }
  for (const [key, text] of Object.entries(texts)) {
    const segs = segmentsOfKey(doc, key);
    if (segs.length !== 1 || segs[0] !== 'ordinary' || exempted.has(key)) continue;
    const hits = keywordHits(text);
    if (hits.length > 0) {
      problems.push(
        `${where}: ${key} is ordinary but its text hits ${hits.join(' ')}; ` +
          'classify it fund_terms or add an exempt entry with a reason',
      );
    }
  }
  return problems;
}

/** Reads specs/fund-term-keys.yaml, contracts/texts.default.json and notify_template_code. */
export function checkFundTermKeys(
  enums: readonly EnumDef[],
  file: string = fundTermKeysFile,
  texts: string = textsFile,
): string[] {
  const where = 'specs/fund-term-keys.yaml';
  let raw: unknown;
  let textMap: Record<string, string>;
  try {
    raw = loadFundTermKeys(file);
  } catch (err) {
    return [`${where}: ${err instanceof Error ? err.message : String(err)}`];
  }
  try {
    const doc = JSON.parse(readFileSync(texts, 'utf8')) as { texts?: unknown };
    if (!isObj(doc.texts)) return [`${where}: contracts/texts.default.json has no texts object`];
    textMap = Object.fromEntries(Object.entries(doc.texts).map(([k, v]) => [k, String(v)]));
  } catch (err) {
    return [
      `${where}: contracts/texts.default.json: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }
  const codes = enums.find((e) => e.name === 'notify_template_code')?.values.map((v) => v.value);
  if (codes === undefined) return [`${where}: enum notify_template_code not found`];
  return checkFundTermDoc(raw, textMap, codes, where);
}
