import { maskPlistDoctype } from './plist-doctype.ts';
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

/** 资源表键名里凭据词的连写前缀（apikey、accesstoken 等）；monkey、hockey、tokenizer 不算。 */
const CREDENTIAL_WORD =
  /^(?:(?:api|app|access|auth|client|refresh|session|bearer|id|sdk|master|license|licence|map|push|oauth|consumer|upload|device|user|secret|private|public|encrypt|encryption|aes|des|rsa|jwt|csrf|xsrf|ak|sk|service|server)?(?:key|token|credential)s?)$/;

/**
 * 字段名对应的规则。resourceNames=true 用于资源表（arsc）键值视图：资源名是任意标识符，
 * keyed-credential 只认整词或已知连写的 key / token / credential，不按子串命中；签名材料与服务端密钥口径不变。
 */
export function fieldRule(name: string, resourceNames = false): DetectRuleId | undefined {
  const words = name
    .replace(/^(?:(?:this|window|globalThis|global|self)\.)+/, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[._$-]+/);
  const has = (word: string): boolean => words.includes(word);
  const salt = words.some(
    (word, i) =>
      word === 'salt' &&
      !/^(?:rounds|length|len|size|bits|count|iterations|cost)$/.test(words[i + 1] ?? ''),
  );
  if (
    salt ||
    has('hmac') ||
    (has('install') && has('secret')) ||
    words.some((word) =>
      /^(?:installsecret|sign(?:ing)?(?:key|secret|salt)|hmac(?:key|secret)|sharedsalt)$/.test(
        word,
      ),
    ) ||
    ((has('sign') || has('signing')) && (has('key') || has('secret')))
  )
    return 'request-sign-material';
  // 服务端密钥和其他凭据沿用原有格式覆盖；本轮只修签名材料的子串误判。
  const key = name.replace(/[._-]/g, '').toLowerCase();
  if (/secret|password|passwd|privatekey|apiv3/.test(key)) return 'server-secret';
  if (resourceNames)
    return words.some((word) => CREDENTIAL_WORD.test(word)) ? 'keyed-credential' : undefined;
  if (/key|token|credential/.test(key)) return 'keyed-credential';
  return;
}

/** NUL、其他控制码（制表与换行除外）和 0x7F 以上的单字节视为二进制串的边界。 */
function binaryByte(char: string | undefined): boolean {
  return char !== undefined && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\xff]/.test(char);
}

const STANDALONE_SCAN = 16_384;
const PAIR_LIST =
  /^[ \t]*[A-Za-z_$][\w$.-]*=[^\s,;&"'`<]+(?:[ \t]*[,;&][ \t]*[A-Za-z_$][\w$.-]*=[^\s,;&"'`<]+)+[ \t]*$/;

/**
 * 二进制里提取出的独立可打印串（所在文本块至少一端是 NUL / 不可打印字节），
 * 如原生库中 NUL 分隔的 `shared_salt=prod-v1`，按配置逐行处理：
 * - 整串是 `k=v,k=v` / `k=v&k=v` 这类键值列表时，每个取值在 , ; & 处截止；
 * - 否则整串必须只有这一个 `key=value`，取值一直到串尾（可含标点）。
 * 其余情况（如 `window.apiKey=null,window.shared_salt="…";` 这类代码表达式）不算，交回代码规则处理，
 * 不推进游标，后面的字段照常检查。
 */
function standaloneValue(
  text: string,
  keyAt: number,
  valueAt: number,
  separator: string,
): string | undefined {
  if (separator !== '=') return;
  const printable = (char: string | undefined): boolean =>
    char !== undefined && (char === '\t' || (char >= ' ' && char <= '~'));
  let start = keyAt;
  while (start > 0 && printable(text[start - 1])) {
    if (keyAt - --start > STANDALONE_SCAN) return;
  }
  let end = valueAt;
  while (end < text.length && printable(text[end])) {
    if (++end - valueAt > STANDALONE_SCAN) return;
  }
  // 多行文本块嵌在二进制里时，块的两端是二进制字节，块内每行各自判定。
  const inBlock = (char: string | undefined): boolean =>
    printable(char) || char === '\n' || char === '\r';
  if (!binaryByte(text[start - 1]) && !binaryByte(text[end])) {
    let blockStart = start;
    while (blockStart > 0 && inBlock(text[blockStart - 1])) {
      if (start - --blockStart > STANDALONE_SCAN) return;
    }
    let blockEnd = end;
    while (blockEnd < text.length && inBlock(text[blockEnd])) {
      if (++blockEnd - end > STANDALONE_SCAN) return;
    }
    if (!binaryByte(text[blockStart - 1]) && !binaryByte(text[blockEnd])) return;
  }
  const run = text.slice(start, end);
  if (PAIR_LIST.test(run)) return /^[^\s,;&"'`<]+/.exec(text.slice(valueAt, end))?.[0];
  if (text.slice(start, keyAt).trim() !== '') return;
  const value = /^[^\s<"'`]+/.exec(text.slice(valueAt, end))?.[0];
  if (!value || text.slice(valueAt + value.length, end).trim() !== '') return;
  return value;
}

/** 下一行开头是新键：`键:`（冒号后空白或行尾）/ `键=` / 引号键后跟 `:` 或 `=`；YAML 列表项不算。 */
const NEW_KEY =
  /^(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\\n])*`)\s*[:=]|^[A-Za-z_$][\w$.-]*[ \t]*(?:=|:(?!\S))/;

/** YAML 里只有 `键:` / `"键":`（冒号后空白或行尾）是新键；`=` 在 YAML 标量里只是取值的一部分。 */
const YAML_NEW_KEY =
  /^(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')[ \t]*:(?!\S)|^[A-Za-z_$][\w$.-]*[ \t]*:(?!\S)/;

/** 整行是带填充等号的 Base64 / Base64url 串（如 `c2FsdA==`）：允许续行的格式里这是换行书写的取值，不是 `键=`。 */
const PADDED_BASE64_LINE = /^[A-Za-z0-9+/_-]+={1,2}[ \t]*(?:\r?\n|$)/;

/**
 * 不允许换行续写取值的格式：.properties（只有行尾反斜杠才续行）与 .env。这里空值键后的下一行一律按
 * 行首形状判新键，`mode=`、`channel=` 这类空值键不能当作上一行空值的 Base64 续行。
 * YAML、ini / cfg / conf 与其他内容允许缩进续行，Base64 填充行仍按续行取值（与 main 同口径）。
 */
const NO_CONTINUATION = /(?:\.(?:properties|env)|(?:^|\/)\.env(?:\.[^/]*)?)$/i;

function newKeyAt(rest: string, yaml: boolean, noContinuation: boolean): boolean {
  if (noContinuation) return NEW_KEY.test(rest);
  if (PADDED_BASE64_LINE.test(rest)) return false;
  return (yaml ? YAML_NEW_KEY : NEW_KEY).test(rest);
}

/** 算法参数后缀（位数、版本、轮数、长度、时效等）：带这些词的数字取值是参数，不是材料。 */
const PARAMETER_WORD =
  /^(?:bits?|version|ver|v\d*|rounds?|length|len|size|count|iterations?|iter|cost|level|mode|type|alg|algorithm|index|idx|id|ttl|timeout|expir(?:y|e[sd]?|ation)|interval|enabled?|disabled?|on|off|flag|switch|duration|period|age|seconds?|secs?|ms|millis|minutes?|hours?|days?)$/;

/** 布尔前缀：useHmac / enableSign / isSalted / hasSecret 的数字是开关。 */
const SWITCH_PREFIX = /^(?:use|enable|disable|is|has|should|can|need|allow|with|no|skip)$/;

/** 材料本体词（含 sharedsalt、hmackey、signingsecret 连写）；hmac、sign、signature 这类纯算法名不算。 */
const MATERIAL_WORD = /(?:salt|secret|key)$/;

/**
 * JSON 数字取值按签名材料检测的条件：键名本身是签名材料名、含材料本体词（salt / secret / *_key），
 * 不以开关前缀开头，最后一个材料本体词之后不带算法参数或时效词。不设位数门槛：任何数字（短数字、负数、小数、科学计数法）都检测；
 * 开关与参数（useHmac:1、hmac:0、hmacKeyExpiry:3600、saltRounds:10）只按键名语义排除。
 */
function numericMaterial(name: string): boolean {
  if (fieldRule(name) !== 'request-sign-material') return false;
  const words = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[._$-]+/)
    .filter((word) => word !== '');
  if (words.length === 0 || SWITCH_PREFIX.test(words[0]!)) return false;
  // 参数 / 时效词只在最后一个材料本体词之后（saltRounds、signKeyVersion、hmacKeyExpiry）才说明取值是参数；
  // 材料词之前的版本或前缀（v1_sign_salt、legacySignSalt）仍是材料。
  const last = words.findLastIndex((word) => MATERIAL_WORD.test(word));
  if (last < 0) return false;
  return !words.slice(last + 1).some((word) => PARAMETER_WORD.test(word));
}

/** 每种布局都保留原始字符偏移；后续去重和行号不依赖重新序列化。 */
function fields(
  file: string,
  text: string,
  resourceNames: boolean,
  rawStrings: boolean,
): Array<{ name: string; value: string; start: number }> {
  const found: Array<{ name: string; value: string; start: number }> = [];
  const configFile =
    /(?:\.(?:properties|ini|cfg|conf|env|yaml|yml)|(?:^|\/)\.env(?:\.[^/]*)?)$/i.test(file);
  const yamlFile = /\.ya?ml$/i.test(file);
  const noContinuation = NO_CONTINUATION.test(file);
  // 前端代码与 JSON 的 latin1 视图里，UTF-8 多字节也是 0x80 以上的字节，不能当作二进制串边界。
  // 资源字符串原值视图（NUL 分隔的独立串）不是代码文本，即使引用方是 module.json 也按独立串判定。
  const codeFile =
    !rawStrings &&
    /\.(?:[cm]?js|jsx|tsx?|html?|css|json|map|vue|svelte|jsbundle|bundle|wxml|wxss)$/i.test(file);
  // 未知格式只认整份纯配置文本；对象路径和代码语句不能靠行首的 '=' 冒充配置。
  const plainConfig = text
    .split(/\r?\n/)
    .every(
      (line) =>
        /^\s*(?:(?:#|\/\/).*|[A-Za-z_$][\w$-]*\s*=\s*[^\s"'`]+)?\s*$/.test(line) &&
        !/[,;)}]\s*[A-Za-z_$][\w$.-]*\s*=/.test(line),
    );
  const add = (name: string, value: string, start: number): void => {
    found.push({ name, value, start });
  };
  const assignment = /(?<![\w$.-])(["'`]?)([A-Za-z_$][\w$.-]*)["'`]?\s*([:=])[ \t]*/g;
  let m: RegExpExecArray | null;
  while ((m = assignment.exec(text))) {
    const quotedKey = m[1] !== '';
    const name = m[2]!;
    const separator = m[3]!;
    // 普通变量赋值不能吞掉内层对象字段，例如压缩后的 c={appSecret:"…"}。
    if (!fieldRule(name, resourceNames)) continue;
    // 分隔符后换行时（跳过空行与 # 注释行），下一处内容若是新键（`键:` / `键=` / `"键":`，含缩进的嵌套映射）就不跨行取值，
    // 如 `shared_salt=` 空值后跟 `app.name=foo`、`hmac:` 后跟缩进的 `algorithm: sha256`；
    // 其余缩进更深的取值（YAML 换行写的 `sign_salt:\n  值`，含引号值）仍按该字段检测。
    if (text[assignment.lastIndex] === '\n' || text[assignment.lastIndex] === '\r') {
      const next = /^(?:\s|#[^\n]*)*/.exec(
        text.slice(assignment.lastIndex, assignment.lastIndex + 4096),
      )![0];
      const nextAt = assignment.lastIndex + next.length;
      if (
        nextAt < text.length &&
        !newKeyAt(text.slice(nextAt, nextAt + 4096), yamlFile, noContinuation)
      ) {
        assignment.lastIndex = nextAt;
      }
    }
    const valueAt = assignment.lastIndex;
    const raw = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/.exec(
      text.slice(valueAt),
    );
    if (raw) {
      add(name, raw[1] ?? raw[2] ?? raw[3] ?? '', valueAt + 1);
      assignment.lastIndex += raw[0].length;
      continue;
    }
    // 只有配置文件或整份纯 key=value 文本保留裸值中的标点。
    let before = m.index - 1;
    while (before >= 0 && (text[before] === ' ' || text[before] === '\t')) before--;
    const lineStart = before < 0 || text[before] === '\n' || text[before] === '\r';
    const standalone = codeFile ? undefined : standaloneValue(text, m.index, valueAt, separator);
    const config =
      (lineStart && (configFile || (plainConfig && separator === '='))) || !!standalone;
    const bare =
      standalone ??
      (config ? /^[^\s<\x00-\x1f"'`]+/ : /^[^\s<\x00-\x1f"'`,{}();\u005b\u005d]+/).exec(
        text.slice(valueAt),
      )?.[0];
    if (!bare) continue;
    // 引号键后的数字字面量（JSON 的 {"sign_salt": 20240101}）是取值本身，按字段口径检测。
    // 只有键名本身是签名材料名时才检测；hmac_bits、signKeyVersion 这类算法参数不算。
    if (
      !config &&
      quotedKey &&
      separator === ':' &&
      /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(bare) &&
      numericMaterial(name)
    ) {
      add(name, bare, valueAt);
      assignment.lastIndex += bare.length;
      continue;
    }
    // JS 的裸标识符、null、数字和表达式均不算材料字面值；也不推进游标吞下后续赋值。
    if (!config || /^(?:%[sdif]|%\d+\$[sdif])$/.test(bare)) continue;
    add(name, bare, valueAt);
    assignment.lastIndex += bare.length;
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

/** DER 私钥外层是 SEQUENCE + version INTEGER + RSA INTEGER / PKCS#8 SEQUENCE / SEC1 OCTET STRING。
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
    (bytes[at + 3] === 2 || bytes[at + 3] === 0x30 || (bytes[at + 2] === 1 && bytes[at + 3] === 4))
  );
}

export function detectText(
  file: string,
  source: string,
  options: DetectOptions,
  resourceNames = false,
  rawStrings = false,
): ScanHit[] {
  // XML plist 的完整标准 DOCTYPE 按结构识别后等长置空（行号、偏移不变），其余内容照常检测。
  const text = maskPlistDoctype(source);
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
    // 头尾成对但中间没有 base64 正文（如 SDK 里的 PEM 头尾常量）不是密钥。
    const bodyless = end >= 0 && !/[A-Za-z0-9+/]{16,}/.test(text.slice(m.index + m[0].length, end));
    if (/PRIVATE/i.test(m[1]!)) {
      if (!bodyless) add('private-key', m.index, length);
    } else if (hasHigh(text.slice(m.index, m.index + length))) add('high-entropy', m.index, length);
  }

  for (const { name, value, start } of fields(file, text, resourceNames, rawStrings)) {
    const rule = fieldRule(name, resourceNames);
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
    // 口令段只剩格式占位（%@、%ld、%02x 等）时是格式串模板，不是口令。
    const secret = userInfo
      .slice(userInfo.indexOf(':') + 1)
      .replace(
        /%[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:hh|h|ll|l|q|z|t|j|L)?[@diouxXeEfFgGaAcCsSp]/g,
        '',
      )
      .replace(/%$/, '');
    if (authority.includes('@') && /:[^:]+$/.test(userInfo) && secret.length > 0) {
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
