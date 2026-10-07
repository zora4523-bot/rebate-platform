// 字段视图的共用叶子：JSON 键值行输出与资源引用的解析结果类型。不得从 index.ts 反向导入。

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

export const UNRESOLVED: Resolution = Object.freeze({ finals: [], ok: false }) as Resolution;

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
