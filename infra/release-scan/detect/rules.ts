import type { DetectOptions, DetectRuleId, ScanHit } from './types.ts';

export function defaultDetectOptions(): DetectOptions {
  return { minLength: 20, minEntropy: 3.5 };
}

export function resolveOptions(options: Partial<DetectOptions> = {}): DetectOptions {
  const resolved = { ...defaultDetectOptions(), ...options };
  if (
    !Number.isSafeInteger(resolved.minLength) ||
    resolved.minLength < 1 ||
    !Number.isFinite(resolved.minEntropy) ||
    resolved.minEntropy < 0
  ) {
    throw new Error('Invalid detection thresholds');
  }
  return resolved;
}

export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  let length = 0;
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
    length++;
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

interface Candidate {
  rule: DetectRuleId;
  start: number;
  end: number;
}

const PRIORITY: readonly DetectRuleId[] = [
  'private-key',
  'request-sign-material',
  'server-secret',
  'aliyun-access-key',
  'credential-url',
  'keyed-credential',
  'high-entropy',
];

function fieldRule(name: string): DetectRuleId | undefined {
  const key = name.replace(/[._-]/g, '').toLowerCase();
  if (/salt(?:rounds|length|len|size|bits|count|iterations|cost)$/.test(key)) return;
  if (/installsecret|sign.*(?:key|secret)|hmac|salt/.test(key)) return 'request-sign-material';
  if (/secret|password|passwd|privatekey|apiv3/.test(key)) return 'server-secret';
  if (/key|token|credential/.test(key)) return 'keyed-credential';
  return;
}

/** 每种布局都保留原始字符偏移；后续去重和行号不依赖重新序列化。 */
function fields(text: string): Array<{ name: string; value: string; start: number }> {
  const found: Array<{ name: string; value: string; start: number }> = [];
  const add = (name: string, value: string, start: number): void => {
    found.push({ name, value, start });
  };
  const assignment = /(?<![\w$.-])["'`]?([A-Za-z_$][\w$.-]*)["'`]?\s*([:=])\s*/g;
  let m: RegExpExecArray | null;
  while ((m = assignment.exec(text))) {
    // 普通变量赋值不能吞掉内层对象字段，例如压缩后的 c={appSecret:"…"}。
    if (!fieldRule(m[1]!)) continue;
    const valueAt = assignment.lastIndex;
    const raw = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/.exec(
      text.slice(valueAt),
    );
    if (raw) {
      add(m[1]!, raw[1] ?? raw[2] ?? raw[3] ?? '', valueAt + 1);
      assignment.lastIndex += raw[0].length;
      continue;
    }
    // 行首配置赋值允许标点（冻结属性测试涵盖逗号、括号等盐值）。
    // 内联代码的裸值则在语法分隔符处截止，不能吞掉后面的字段。
    let before = m.index - 1;
    while (before >= 0 && (text[before] === ' ' || text[before] === '\t')) before--;
    const config = before < 0 || text[before] === '\n' || text[before] === '\r';
    const bare = (
      config && m[2] === '=' ? /^[^\s<\x00-\x1f"'`]+/ : /^[^\s<\x00-\x1f"'`,{}();\u005b\u005d]+/
    ).exec(text.slice(valueAt));
    if (!bare) continue;
    // 冒号在配置行中表示取值；代码里的标识符、调用和表达式不是字面材料。
    const codeTail = /^[ \t]*[,});]/.test(text.slice(valueAt + bare[0].length));
    if (m[2] === ':' && (!config || codeTail) && !/^(?:[+-]?\d+(?:\.\d+)?)$/.test(bare[0]))
      continue;
    add(m[1]!, bare[0], valueAt);
    assignment.lastIndex += bare[0].length;
  }
  const resource = /<string\b[^>]*\bname\s*=\s*(["'])([^"']+)\1[^>]*>([^<]*)/gi;
  for (const m of text.matchAll(resource)) {
    add(m[2]!, m[3]!, m.index + m[0].length - m[3]!.length);
  }
  const plist = /<key\b[^>]*>([^<]+)<\/key>\s*<(?:string|integer|data)\b[^>]*>([^<]*)/gi;
  for (const m of text.matchAll(plist)) {
    add(m[1]!, m[2]!, m.index + m[0].length - m[2]!.length);
  }
  for (const tag of text.matchAll(/<meta-data\b[^>]*>/gi)) {
    const name = /\bandroid:name\s*=\s*(["'])(.*?)\1/i.exec(tag[0]);
    const value = /\bandroid:value\s*=\s*(["'])(.*?)\1/i.exec(tag[0]);
    if (name && value) {
      add(name[2]!, value[2]!, tag.index + value.index + value[0].length - value[2]!.length - 1);
    }
  }
  return found;
}

/** DER 私钥外层是 SEQUENCE + version INTEGER + RSA INTEGER / PKCS#8 SEQUENCE。
 * SPKI 公钥从算法 SEQUENCE 开始，不含 version，因此不会升级为不可豁免。
 */
function privateDerPrefix(value: string): boolean {
  if (value.length < 32 || !value.startsWith('M')) return false;
  const bytes = Buffer.from(value.slice(0, 128), 'base64');
  if (bytes[0] !== 0x30) return false;
  const length = bytes[1];
  if (length === undefined || length === 0x80 || length > 0x84) return false;
  const at = length < 0x80 ? 2 : 2 + (length & 0x7f);
  return (
    bytes[at] === 2 &&
    bytes[at + 1] === 1 &&
    (bytes[at + 2] === 0 || bytes[at + 2] === 1) &&
    (bytes[at + 3] === 2 || bytes[at + 3] === 0x30)
  );
}

export function detectText(file: string, text: string, options: DetectOptions): ScanHit[] {
  const candidates: Candidate[] = [];
  const add = (rule: DetectRuleId, start: number, length: number): void => {
    if (length > 0) candidates.push({ rule, start, end: start + length });
  };
  const high = (value: string): boolean =>
    value.length >= options.minLength &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value) &&
    shannonEntropy(value) >= options.minEntropy;
  const hasHigh = (value: string): boolean =>
    [...value.matchAll(/[A-Za-z0-9+/=_-]+/g)].some((m) => high(m[0]));

  for (const m of text.matchAll(
    /-----BEGIN ([A-Z0-9 ]*(?:PRIVATE KEY(?: BLOCK)?|PUBLIC KEY))-----/gi,
  )) {
    const footer = `-----END ${m[1]}-----`;
    const footerPattern = new RegExp(footer, 'gi');
    footerPattern.lastIndex = m.index + m[0].length;
    const end = footerPattern.exec(text)?.index ?? -1;
    // 缺 footer 的私钥也阻断，并将紧接的正文并入同一命中。
    const tail =
      end < 0 ? (/^[\sA-Za-z0-9+/=\\-]*/.exec(text.slice(m.index + m[0].length))?.[0] ?? '') : '';
    const length = end < 0 ? m[0].length + tail.length : end + footer.length - m.index;
    if (/PRIVATE/i.test(m[1]!)) add('private-key', m.index, length);
    else if (hasHigh(text.slice(m.index, m.index + length))) add('high-entropy', m.index, length);
  }

  for (const { name, value, start } of fields(text)) {
    const rule = fieldRule(name);
    if (!rule || value.length === 0) continue;
    if (rule === 'request-sign-material') add(rule, start, value.length);
    else {
      const token = /^[A-Za-z0-9+/=_-]{16,}/.exec(value)?.[0];
      if (token && /[0-9]/.test(token)) add(rule, start, token.length);
    }
  }
  for (const m of text.matchAll(/\bLTAI[A-Za-z0-9]{12,20}(?![A-Za-z0-9])/g)) {
    add('aliyun-access-key', m.index, m[0].length);
  }
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`\x00-\x1f]+/g)) {
    // 只在 authority 的 userinfo 中判口令，路径或 query 的冒号不算。
    const authority = m[0].slice(m[0].indexOf('://') + 3).split(/[/?#]/, 1)[0]!;
    const userInfo = authority.slice(0, authority.lastIndexOf('@'));
    if (authority.includes('@') && /:[^:]+$/.test(userInfo)) {
      add('credential-url', m.index, m[0].length);
    } else if (hasHigh(m[0])) add('high-entropy', m.index, m[0].length);
  }
  for (const m of text.matchAll(/[A-Za-z0-9+/=_-]+/g)) {
    if (privateDerPrefix(m[0])) add('private-key', m.index, m[0].length);
    if (high(m[0])) add('high-entropy', m.index, m[0].length);
  }

  // 每层优先级都与已选区间线性合并；避免压缩大文件中逐候选遍历全部命中。
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  let selected: Candidate[] = [];
  for (const rule of PRIORITY) {
    const merged: Candidate[] = [];
    let cursor = 0;
    for (const candidate of candidates) {
      if (candidate.rule !== rule) continue;
      while (cursor < selected.length && selected[cursor]!.end <= candidate.start) {
        merged.push(selected[cursor++]!);
      }
      const previous = merged[merged.length - 1];
      const next = selected[cursor];
      if (
        (!previous || previous.end <= candidate.start) &&
        (!next || candidate.end <= next.start)
      ) {
        merged.push(candidate);
      }
    }
    while (cursor < selected.length) merged.push(selected[cursor++]!);
    selected = merged;
  }
  const newlines: number[] = [];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) newlines.push(at);
  const lineAt = (start: number): number => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (newlines[mid]! < start) low = mid + 1;
      else high = mid;
    }
    return low + 1;
  };
  return selected.map(({ rule, start, end }) => ({
    rule,
    file,
    line: lineAt(start),
    match: text.slice(start, end),
    never_accepted: rule !== 'keyed-credential' && rule !== 'high-entropy',
  }));
}
