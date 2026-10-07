// 字段视图的共用叶子：JSON 键值行输出与资源引用的解析结果类型。不得从 index.ts 反向导入。
import { fieldRule } from './rules.ts';

/** 资源引用解析出的一个最终取值。 */
export interface Final {
  text: string;
  /** 文件类资源的路径取值：只作孤立字符串检测，不配字段名。 */
  file: boolean;
}

/** 一次引用解析：ok=false 表示有候选解析不了（缺表、缺 ID、成环、超深度、外部资源）。 */
export interface Resolution {
  finals: Final[];
  ok: boolean;
}

/** 读同一包内的文件资源（路径按资源表里的写法）；读不到或不在本包内返回 undefined。 */
export type FileReader = (path: string) => string | undefined;

/**
 * 按引用方字段名输出一个解析结果。文件类取值只作孤立路径输出；
 * 但签名材料字段引用文件资源时，读同包内该文件内容按「字段 = 内容」输出，读不到即 fail-closed。
 */
export function emitFinal(
  emit: (value: string, key?: string) => void,
  final: Final,
  key: string,
  readFile: FileReader | undefined,
  fail: () => never,
): void {
  if (!final.file) {
    emit(final.text, key);
    return;
  }
  emit(final.text);
  if (fieldRule(key) !== 'request-sign-material') return;
  const content = readFile?.(final.text);
  if (content === undefined) fail();
  emit(content.trim(), key);
}

export const UNRESOLVED: Resolution = Object.freeze({ finals: [], ok: false }) as Resolution;

/**
 * name 属性给出的关联名：文字取值，加上编译成资源引用（@string/…）时解析出的字符串。
 * name 引用解析不了（缺表、缺 ID、只得到文件路径）而元素又有 value / resource 取值时，
 * 无法判断取值是不是签名材料，按签名字段 fail-closed。
 */
export function associationNames<R>(
  attrs: ReadonlyArray<{
    name: string;
    values: readonly string[];
    refs: readonly R[];
    files?: readonly string[];
  }>,
  resolve: ((ref: R) => Resolution) | undefined,
  fail: () => never,
): string[] {
  const names = new Set<string>();
  let unresolved = false;
  for (const attr of attrs) {
    if (attr.name !== 'name') continue;
    for (const value of attr.values) names.add(value);
    if (attr.refs.length > 0 && !resolve) unresolved = true;
    if (!resolve) continue;
    for (const ref of attr.refs) {
      let resolved: Resolution;
      try {
        resolved = resolve(ref);
      } catch {
        resolved = UNRESOLVED;
      }
      const texts = resolved.finals.filter((final) => !final.file).map((final) => final.text);
      if (!resolved.ok || texts.length === 0) unresolved = true;
      for (const text of texts) names.add(text);
    }
  }
  if (
    unresolved &&
    attrs.some(
      (attr) =>
        (attr.name === 'value' || attr.name === 'resource') &&
        (attr.values.length > 0 || attr.refs.length > 0 || (attr.files?.length ?? 0) > 0),
    )
  )
    fail();
  return [...names];
}

const MAX_LINES = 2_000_000;
const MAX_OUTPUT = 256 * 1024 * 1024;

/** 逐行输出 `"键":"值"` 或孤立的 `"值"`；同一行只输出一次，超出预算即抛错（fail-closed）。 */
export class LineSink {
  private readonly emitted = new Set<string>();
  private readonly lines: string[] = [];
  private size = 0;
  /** 已作为键或值出现过的字符串。 */
  readonly used = new Set<string>();
  private readonly fail: () => never;

  constructor(fail: () => never) {
    this.fail = fail;
  }

  emit(value: string, key?: string): void {
    const line =
      key === undefined ? JSON.stringify(value) : `${JSON.stringify(key)}:${JSON.stringify(value)}`;
    if (key !== undefined) this.used.add(key);
    this.used.add(value);
    if (this.emitted.has(line)) return;
    this.emitted.add(line);
    this.size += line.length + 1;
    if (this.size > MAX_OUTPUT || this.lines.length >= MAX_LINES) this.fail();
    this.lines.push(line);
  }

  text(): string {
    return this.lines.join('\n');
  }
}

/** 取二进制里长度 ≥ 4 的可打印 ASCII 串（未知字段、来源池等只作孤立字符串检测）。 */
export function printableRuns(bytes: Uint8Array): string[] {
  const runs: string[] = [];
  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    const b = i < bytes.length ? bytes[i]! : 0;
    const printable = (b >= 0x20 && b <= 0x7e) || b === 9;
    if (printable && start < 0) start = i;
    if (!printable && start >= 0) {
      if (i - start >= 4) runs.push(Buffer.from(bytes.subarray(start, i)).toString('latin1'));
      start = -1;
    }
  }
  return runs;
}
