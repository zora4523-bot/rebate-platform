// 发布制品扫描第三段：Release 制品里的调试能力与测试环境残留（规划/03 §3.6「发布制品扫描」；02 §12.6 末句；
// 05 QA-09 后半句；10 AC-S1-86 ①②）。任何一项命中即阻断发布；残留命中不经公开标识清单比对，不设豁免。
// 口径由规则测试 test/spec/release-scan/residue/** 逐条约束（规则表见 detect.test.ts 文件头）。
import { textViews } from '../detect/encoding.ts';
import { domainOccurrences } from './domains.ts';

export { readApprovals, readArguments } from './config.ts';

/** 复用 QA-09b 的解析导出，完整制品必须校验资源表（包括损坏的头）。 */
export function artifactTextViews(file: string, content: Uint8Array): string[] {
  return textViews(content, file, true);
}

/** 残留规则编号（03 §3.6 逐项）。 */
export type ResidueRuleId =
  | 'test-domain'
  | 'clock-offset'
  | 'env-switch'
  | 'diagnostic-panel'
  | 'debug-route'
  | 'conformance-entry'
  | 'debuggable'
  | 'webview-debug';

/** 一条残留命中；残留命中一律阻断。 */
export interface ResidueHit {
  rule: ResidueRuleId;
  /** 制品内相对路径（同 QA-09b 的条目路径），原样保留调用方给的 file。 */
  file: string;
  /** 从 1 开始；二进制解析视图（AXML 等）为解析视图中的行号。 */
  line: number;
  /** 命中的原文片段；test-domain 为主机名（不含端口），debug-route 为命中的标识符。 */
  match: string;
}

export interface ResidueOptions {
  /** contracts/routes.json 中 debug_only 为 true 的路由名（由 debugOnlyRoutes 读出）。 */
  debugRoutes: readonly string[];
}

/**
 * 读 contracts/routes.json 原文，返回 debug_only 为 true 的路由名（按码点升序）。
 * 不是 JSON、缺 routes 对象或 debug_only 不是布尔值时抛错（调用方按读取失败处理）。
 */
export function debugOnlyRoutes(routesJson: string): string[] {
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const root: unknown = JSON.parse(routesJson);
  if (!object(root) || !object(root.routes)) throw new Error('Invalid routes object');
  const routes: string[] = [];
  for (const [name, route] of Object.entries(root.routes)) {
    if (
      !object(route) ||
      (Object.hasOwn(route, 'debug_only') && typeof route.debug_only !== 'boolean')
    )
      throw new Error('Invalid route metadata');
    if (route.debug_only === true) {
      if (words(name).length === 0) throw new Error('Invalid debug route name');
      routes.push(name);
    }
  }
  return routes.sort();
}

function words(identifier: string): string[] {
  return identifier
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_$-]+/)
    .filter(Boolean);
}

function contains(sequence: readonly string[], needle: readonly string[]): boolean {
  return (
    needle.length > 0 &&
    sequence.some((_, i) => needle.every((word, j) => sequence[i + j] === word))
  );
}

const WORD_RULES: ReadonlyArray<[ResidueRuleId, readonly string[][]]> = [
  ['clock-offset', [['client', 'clock', 'offset']]],
  [
    'env-switch',
    [
      ['env', 'switch'],
      ['env', 'switcher'],
      ['environment', 'switch'],
      ['environment', 'switcher'],
      ['switch', 'env'],
      ['switcher', 'env'],
      ['switch', 'environment'],
      ['switcher', 'environment'],
      ['server', 'switch'],
      ['server', 'switcher'],
      ['switch', 'server'],
      ['switcher', 'server'],
    ],
  ],
  [
    'diagnostic-panel',
    ['diagnostic', 'diagnostics', 'debug', 'log', 'logs'].flatMap((word) => [
      [word, 'panel'],
      [word, 'menu'],
    ]),
  ],
];

function conformanceEntry(
  identifier: string,
  sequence: readonly string[],
  after: string,
  before: string,
): boolean {
  // Swift 运行时与 mangled 符号中的 protocol conformance 不是测试页入口。
  if (/^_?(?:\$[sS]|_T)/.test(identifier) || /^_*swift_/i.test(identifier)) return false;
  if (!sequence.includes('conformance')) return false;
  if (
    [
      'test',
      'page',
      'entry',
      'screen',
      'runner',
      'route',
      'activity',
      'fragment',
      'view',
      'viewcontroller',
      'controller',
      'suite',
    ].some(
      (word) =>
        contains(sequence, ['conformance', word]) || contains(sequence, [word, 'conformance']),
    )
  )
    return true;
  // conformance 与 bridge-conformance 只在页面文件名或路由路径段里认作入口。
  return (
    ['conformance', 'bridge-conformance'].includes(identifier.toLowerCase()) &&
    (/^\.html?(?=$|[^A-Za-z0-9_$-])/i.test(after) ||
      (before === '/' && /^(?:$|[/?#"'`\s\x00-\x1f])/.test(after)))
  );
}

function detectText(
  file: string,
  text: string,
  routes: readonly string[][],
  binary: 'axml' | 'plist' | undefined,
): ResidueHit[] {
  const found: Array<ResidueHit & { offset: number }> = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const add = (rule: ResidueRuleId, offset: number, match: string): void => {
    let lo = 0;
    let hi = lineStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (lineStarts[mid]! <= offset) lo = mid + 1;
      else hi = mid;
    }
    found.push({ rule, file, line: lo, match, offset });
  };
  const scan = (rule: ResidueRuleId, pattern: RegExp): void => {
    for (const match of text.matchAll(pattern)) add(rule, match.index, match[0]);
  };
  for (const { offset, host } of domainOccurrences(text)) add('test-domain', offset, host);
  for (const match of text.matchAll(/[A-Za-z0-9_$-]+/g)) {
    const sequence = words(match[0]);
    for (const [rule, patterns] of WORD_RULES) {
      if (patterns.some((pattern) => contains(sequence, pattern))) add(rule, match.index, match[0]);
    }
    if (
      match[0] === '__RESULT__' ||
      conformanceEntry(
        match[0],
        sequence,
        text.slice(match.index + match[0].length),
        text[match.index - 1] ?? '',
      )
    )
      add('conformance-entry', match.index, match[0]);
    if (routes.some((route) => contains(sequence, route)))
      add('debug-route', match.index, match[0]);
  }
  scan('clock-offset', /时钟偏移/g);
  scan('env-switch', /切换环境|环境切换|切换服务器/g);
  scan('diagnostic-panel', /诊断面板|调试面板|调试菜单/g);
  scan('conformance-entry', /一致性测试/g);
  scan('debuggable', /\bandroid:debuggable\s*=\s*(["'])true\1/g);
  scan('debuggable', /<key>get-task-allow<\/key>\s*<true\s*\/>/g);
  if (binary === 'axml') {
    for (const match of text.matchAll(/^"debuggable":"(true|[0-9]+)"$/gm)) {
      if (match[1] === 'true' || Number(match[1]) !== 0) add('debuggable', match.index, match[0]);
    }
  }
  if (binary === 'plist') scan('debuggable', /^"get-task-allow":true$/gm);
  if (/(?:^|\/)module\.json$/.test(file)) {
    // 校验完整 JSON；随后在原文上定位以保留行号及重复键的命中。
    JSON.parse(text);
    scan('debuggable', /"debug"\s*:\s*true\b/g);
  }
  scan(
    'webview-debug',
    /\b(?:setWebContentsDebuggingEnabled|setWebDebuggingAccess)\s*\(\s*true\s*\)/g,
  );
  scan('webview-debug', /\bisInspectable\s*=\s*(?:true|YES)\b/g);
  scan('webview-debug', /\bsetInspectable\s*:\s*YES\b/g);
  return found
    .sort((a, b) => a.offset - b.offset)
    .map(({ rule, file, line, match }) => ({ rule, file, line, match }));
}

/** 对一个制品条目跑全部残留规则；二进制 AndroidManifest（AXML）按解析视图检测，损坏时抛错。 */
export function detectResidue(
  file: string,
  content: string | Uint8Array,
  options: ResidueOptions,
): ResidueHit[] {
  const routes = options.debugRoutes.map(words);
  if (typeof content === 'string') return detectText(file, content, routes, undefined);
  const bytes = Buffer.from(content);
  const views = artifactTextViews(file, bytes);
  const binary =
    bytes.subarray(0, 8).toString('ascii') === 'bplist00'
      ? 'plist'
      : bytes.length >= 2 &&
          bytes.readUInt16LE(0) === 3 &&
          (/\.xml$/i.test(file) || (bytes.length >= 8 && bytes.readUInt32LE(4) === bytes.length))
        ? 'axml'
        : undefined;
  // QA-09b 的普通字节视图是 latin1；改用 UTF-8 保留中文标识，ASCII 与换行不变。
  if (views[0] === bytes.toString('latin1')) views[0] = bytes.toString('utf8');
  return views.flatMap((view) => detectText(file, view, routes, binary));
}
