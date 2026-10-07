import type { DetectOptions, DetectRuleId, ScanHit } from './index.ts';

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
  const key = name.replace(/[_-]/g, '').toLowerCase();
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
  const assignment = /(?<![\w$-])["'`]?([A-Za-z_$][\w$-]*)["'`]?\s*[:=]\s*/g;
  let m: RegExpExecArray | null;
  while ((m = assignment.exec(text))) {
    // 普通变量赋值不能吞掉内层对象字段，例如压缩后的 c={appSecret:"…"}。
    if (!fieldRule(m[1]!)) continue;
    const raw =
      /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`|([^\s<\x00-\x1f"'`]+))/.exec(
        text.slice(assignment.lastIndex),
      );
    if (!raw) continue;
    const value = raw[1] ?? raw[2] ?? raw[3] ?? raw[4] ?? '';
    const quoted = raw[4] === undefined;
    add(m[1]!, value, assignment.lastIndex + (quoted ? 1 : 0));
    assignment.lastIndex += raw[0].length;
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
    const end = text.toUpperCase().indexOf(footer.toUpperCase(), m.index + m[0].length);
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
    if (high(m[0])) add('high-entropy', m.index, m[0].length);
  }

  // 优先级相同的先保留外层完整块（URL / PEM），再考虑其正文。
  candidates.sort(
    (a, b) =>
      PRIORITY.indexOf(a.rule) - PRIORITY.indexOf(b.rule) || a.start - b.start || b.end - a.end,
  );
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    if (!selected.some((s) => candidate.start < s.end && candidate.end > s.start)) {
      selected.push(candidate);
    }
  }
  return selected
    .sort((a, b) => a.start - b.start)
    .map(({ rule, start, end }) => ({
      rule,
      file,
      line: text.slice(0, start).split('\n').length,
      match: text.slice(start, end),
      never_accepted: rule !== 'keyed-credential' && rule !== 'high-entropy',
    }));
}
