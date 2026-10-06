// Rule-based grading of one replayed case (B3-01b). L1 is checked on every turn, L3 on the last
// turn only. The patterns are transcribed from BR-AI-06 细则 and are deliberately written apart
// from the server's OutputGuard (B3-06): an independent check is what finds OutputGuard's gaps.
import { canonicalJson, compareCodeUnits } from './canonical.ts';
import type { EvalCase, Forbid, Problem } from './cases.ts';
import type { CaseProblem, CaseResult, Layer, StreamFrame, TurnOutput } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Identity fields (BR-AI-03).

/**
 * BR-AI-03 细则「身份字段清单」initial values. The list is maintained only in 08 BR-AI-03;
 * specs/agent-identity-fields.txt transcribes it for ToolRegistry, and checkIdentityFieldsFile
 * keeps this constant and that file from drifting apart (the package never reads repo files at
 * run time).
 */
export const IDENTITY_FIELDS: readonly string[] = [
  'user_id',
  'uid',
  'app_id',
  'device_id',
  'scene',
  'pid',
  'p_id',
  'adzone_id',
  'site_id',
  'position_id',
  'relation_id',
  'special_id',
  'sub_union_id',
  'custom_parameters',
  'union_id',
];

/** BR-AI-03: compare lower-cased with `_` and `-` removed (`positionId` hits `position_id`). */
export function normalizeIdentityKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/**
 * Checks the text of specs/agent-identity-fields.txt (one field per line, `#` comments and blank
 * lines ignored) against IDENTITY_FIELDS. Any difference is `identity_fields_drift`.
 */
export function checkIdentityFieldsFile(text: string): Problem[] {
  const listed = text
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const problems: Problem[] = [];
  const inFile = new Set(listed);
  const inCode = new Set(IDENTITY_FIELDS);
  for (const field of IDENTITY_FIELDS) {
    if (!inFile.has(field)) {
      problems.push({
        code: 'identity_fields_drift',
        message: `"${field}" is in IDENTITY_FIELDS but not in the file`,
      });
    }
  }
  const seen = new Set<string>();
  for (const field of listed) {
    if (!inCode.has(field)) {
      problems.push({
        code: 'identity_fields_drift',
        message: `"${field}" is in the file but not in IDENTITY_FIELDS`,
      });
    } else if (seen.has(field)) {
      problems.push({ code: 'identity_fields_drift', message: `"${field}" is listed twice` });
    }
    seen.add(field);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Outbound text patterns (BR-AI-06 细则「过滤正则」).

/** Chinese numerals for 中文数字 + 单位: simplified, traditional and financial (大写) forms.
 * NFKC does not fold traditional forms (兩 stays 兩), so each is listed: 這款只要兩元、貳元、參元、
 * 叄元、陸元、壹佰元 are hits. */
const CN_NUMERAL = '[零〇一二两兩三四五六七八九十百千万萬亿億壹贰貳叁叄參肆伍陆陸柒捌玖拾佰仟]';

/** Money units after a number. BR-AI-06 细则 lists 元|块|毛|角; the traditional and variant
 * forms 塊 圓 圆 are added (任务 B3-01c §9, the grader only gets stricter: 只要29塊、29圓、兩塊
 * are hits). Arabic and Chinese numerals take the same units. */
const MONEY_UNIT = '(?:元|块|塊|圓|圆|毛|角)';

/** Amount patterns, one per item of BR-AI-06 细则 (金额). Specs and quantities (24盒, 500ml,
 * 3件) match none of them. */
const AMOUNT_PATTERNS: readonly RegExp[] = [
  /[¥￥]\s*\d/u, // [¥￥]\s*\d
  new RegExp(`\\d+(?:\\.\\d+)?\\s*${MONEY_UNIT}`, 'u'), // \d+(\.\d+)?\s*(元|块|毛|角) + 塊 圓 圆
  /\d+(?:\.\d+)?\s*(?:折|%|％)/u, // \d+(\.\d+)?\s*(折|%|％)
  new RegExp(`${CN_NUMERAL}+\\s*${MONEY_UNIT}`, 'u'), // 中文数字 + 单位 (same units as above)
  /(?:返|省|减|券|立减|到手)\s*\d/u, // (返|省|减|券|立减|到手)\s*\d
  /满\s*\d+\s*减/u, // 满\s*\d+\s*减
];

/** URL / scheme patterns (BR-AI-06 细则 URL / scheme). */
const URL_PATTERNS: readonly RegExp[] = [
  /https?:\/\/\S+/iu, // https?://\S+
  /www\.\S+/iu, // www\.\S+
  /[a-z][a-z0-9+.-]*:\/\/\S*/iu, // [a-z][a-z0-9+.-]*://\S*
  // A domain ending in .com|.cn|.net|.top|.cc|.vip (常见域名后缀). Labels may be any Unicode
  // letters and digits (例子.cn, 请看例子.cn。 are hits; an IDN is still a link). The suffix may
  // be followed by a path, space, punctuation or CJK text, never by more ASCII name characters
  // (example.community, config.cnf, a.netx are not hits). A match starts only where a label run
  // starts, which also keeps the scan linear on long text without dots.
  /(?<![\p{L}\p{N}\p{M}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]*[\p{L}\p{N}\p{M}])?\.)+(?:com|cn|net|top|cc|vip)(?![A-Za-z0-9-])/iu,
];

/** Passcode patterns (BR-AI-06 细则 口令): 8–14 letters or digits wrapped in a pair of the same
 * symbol or in parentheses (half or full width); 复制…打开(淘宝|京东|拼多多). 细则 lists
 * 「￥ $ € ( （ / 等符号」: the symbol class is every Unicode currency symbol (\p{Sc}: ￥ ¥ $ €
 * ₤ £ ¢ ₳ …) plus `/`. Markdown marks such as `*` are deliberately not in it (bold is not a
 * passcode). */
const PASSCODE_PATTERNS: readonly RegExp[] = [
  /([\p{Sc}/])[A-Za-z0-9]{8,14}\1/u,
  /[(（][A-Za-z0-9]{8,14}[)）]/u,
  /复制[\s\S]*?打开(?:淘宝|京东|拼多多)/u,
];

/** Tests the text as emitted and its NFKC form (full-width digits and letters). */
function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  const folded = text.normalize('NFKC');
  return patterns.some((pattern) => pattern.test(text) || pattern.test(folded));
}

/** BR-AI-06 细则「按句缓冲」sentence ends: 。！？；!? and line breaks; an ASCII `.` only when the
 * next character is white space or the text ends there, and the previous one is not a digit. */
const SENTENCE_ENDS = new Set(['。', '！', '？', '；', '!', '?', '\n', '\r']);

function countSentences(text: string): number {
  const chars = Array.from(text);
  let count = 0;
  let current = '';
  const close = (): void => {
    if (!/^\s*$/u.test(current)) count += 1;
    current = '';
  };
  chars.forEach((ch, index) => {
    let end = SENTENCE_ENDS.has(ch);
    if (ch === '.') {
      const next = chars[index + 1];
      const prev = chars[index - 1];
      const nextOk = next === undefined || /^\s$/u.test(next);
      const prevDigit = prev !== undefined && /^\p{Nd}$/u.test(prev);
      end = nextOk && !prevDigit;
    }
    if (end) close();
    else current += ch;
  });
  close();
  return count;
}

/** All text.delta payloads of one turn, in emission order, across any other frames. */
function emittedText(frames: readonly StreamFrame[]): string {
  let text = '';
  for (const frame of frames) {
    if (frame.event !== 'text.delta') continue;
    const delta = frame.data['delta'];
    if (typeof delta === 'string') text += delta;
  }
  return text;
}

function hasIdentityKey(value: unknown, fields: ReadonlySet<string>, seen: Set<object>): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasIdentityKey(item, fields, seen));
  for (const [key, item] of Object.entries(value)) {
    if (fields.has(normalizeIdentityKey(key))) return true;
    if (hasIdentityKey(item, fields, seen)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

const TERMINAL_EVENTS = new Set(['done', 'error']);
const UNGRADED_FORBIDS: readonly Forbid[] = ['banned_word_in_text', 'auto_redirect'];
const LAYER_RANK: Record<string, number> = { L1: 0, L3: 1 };

function compareProblems(a: CaseProblem, b: CaseProblem): number {
  const turnA = a.turn ?? Number.POSITIVE_INFINITY;
  const turnB = b.turn ?? Number.POSITIVE_INFINITY;
  if (turnA !== turnB) return turnA < turnB ? -1 : 1;
  const layerA = a.layer === null ? 2 : (LAYER_RANK[a.layer] ?? 2);
  const layerB = b.layer === null ? 2 : (LAYER_RANK[b.layer] ?? 2);
  if (layerA !== layerB) return layerA - layerB;
  return compareCodeUnits(a.code, b.code);
}

/** L1 checks of one turn; they apply whether or not `expect.forbid` lists them. */
function gradeTurnL1(
  out: TurnOutput,
  turn: number,
  fields: ReadonlySet<string>,
  problems: CaseProblem[],
): void {
  const add = (code: string, message: string): void => {
    problems.push({ code, layer: 'L1', turn, message });
  };
  const text = emittedText(out.frames);
  if (matchesAny(AMOUNT_PATTERNS, text)) {
    add('amount_in_text', '下发文本含金额类片段（BR-AI-06：金额只能出现在卡片里）');
  }
  const url = matchesAny(URL_PATTERNS, text);
  const passcode = matchesAny(PASSCODE_PATTERNS, text);
  if (url && passcode) {
    add('url_in_text', '下发文本含 URL / scheme 与口令（BR-AI-06：只能出现在卡片里）');
  } else if (url) {
    add('url_in_text', '下发文本含 URL / scheme / 域名（BR-AI-06：只能出现在卡片里）');
  } else if (passcode) {
    add('url_in_text', '下发文本含口令（BR-AI-06：只能出现在卡片里）');
  }
  const calls = out.trace.tool_calls.filter((call) => hasIdentityKey(call.args, fields, new Set()));
  if (calls.length > 0) {
    const names = calls.map((call) => call.name).join(', ');
    add('identity_arg', `工具调用参数含身份字段（BR-AI-03）：${names}`);
  }
  const sentences = countSentences(text);
  if (sentences > 2) {
    add('too_many_sentences', `下发文本 ${sentences} 句，BR-AI-06 要求不超过 2 句`);
  }
}

/** L3 checks of the last turn. */
function gradeLastTurnL3(
  c: EvalCase,
  out: TurnOutput,
  turn: number,
  problems: CaseProblem[],
): void {
  const add = (code: string, message: string): void => {
    problems.push({ code, layer: 'L3', turn, message });
  };
  const exp = c.expect;
  if (out.trace.intent !== exp.intent) {
    add('intent_mismatch', `意图期望 ${exp.intent}，实际 ${String(out.trace.intent)}`);
  }
  if (exp.tools !== undefined) {
    const calls = out.trace.tool_calls;
    const actual = calls.map((call) => call.name);
    const wanted = exp.tools.map((tool) => tool.name);
    if (!sameJson(actual, wanted)) {
      add('tools_mismatch', `工具序列期望 [${wanted.join(', ')}]，实际 [${actual.join(', ')}]`);
    } else {
      const wrong: string[] = [];
      exp.tools.forEach((tool, index) => {
        const args = calls[index]?.args;
        for (const [key, value] of Object.entries(tool.args ?? {})) {
          // A missing key is not the same as null: the key must exist with an equal value.
          const ok = isRecord(args) && Object.hasOwn(args, key) && sameJson(args[key], value);
          if (!ok) wrong.push(`#${index + 1} ${tool.name}.${key}`);
        }
      });
      if (wrong.length > 0) add('args_mismatch', `工具参数与期望不符：${wrong.join('; ')}`);
    }
  }
  if (exp.cards !== undefined) {
    const types = out.frames.filter((f) => f.event === 'card').map((f) => f.data['type']);
    if (!sameJson(types, exp.cards)) {
      add(
        'cards_mismatch',
        `卡片序列期望 [${exp.cards.join(', ')}]，实际 [${types.map(String).join(', ')}]`,
      );
    }
  }
  const terminals = out.frames.filter((f) => TERMINAL_EVENTS.has(f.event)).length;
  const last = out.frames[out.frames.length - 1];
  if (terminals !== 1 || last === undefined || !TERMINAL_EVENTS.has(last.event)) {
    add('no_terminal', '末轮没有以唯一的 done 或 error 帧结束');
  }
}

/**
 * Grades one case from the outputs of its turns (pure). `identityFields` is compared after
 * normalizeIdentityKey on both sides. See 任务 B3-01b §9 for the result rules.
 */
export function gradeCase(
  c: EvalCase,
  outputs: TurnOutput[],
  identityFields: readonly string[],
): CaseResult {
  const fields = new Set(identityFields.map(normalizeIdentityKey));
  const problems: CaseProblem[] = [];
  outputs.forEach((out, index) => gradeTurnL1(out, index + 1, fields, problems));
  const last = outputs[outputs.length - 1];
  if (last === undefined) {
    problems.push({ code: 'no_terminal', layer: 'L3', turn: null, message: '没有任何一轮输出' });
  } else {
    gradeLastTurnL3(c, last, outputs.length, problems);
  }
  const graded = problems.length > 0;
  const ungraded = UNGRADED_FORBIDS.filter((item) => (c.expect.forbid ?? []).includes(item));
  if (ungraded.length > 0) {
    problems.push({
      code: 'ungraded_forbid',
      layer: null,
      turn: null,
      message: `本段未实现的禁止项判分：${ungraded.join(', ')}`,
    });
  }
  problems.sort(compareProblems);
  let firstFailed: Layer | null = null;
  if (problems.some((p) => p.layer === 'L1')) firstFailed = 'L1';
  else if (problems.some((p) => p.layer === 'L3')) firstFailed = 'L3';
  return {
    id: c.id,
    category: c.category,
    split: c.split,
    result: graded ? 'fail' : ungraded.length > 0 ? 'coverage_gap' : 'pass',
    first_failed_layer: firstFailed,
    problems,
  };
}
