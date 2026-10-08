// QA-09e test 阶段：保留公开接口，命令行装配由实现阶段补全。

/** 报告里的一条命中（不含命中原文）。 */
export interface CliFinding {
  kind: 'secret' | 'residue';
  rule: string;
  file: string;
  line: number;
  verdict: 'allow' | 'block';
}

/** 标准输出上的 JSON 报告。 */
export interface CliReport {
  exit_code: 0 | 1 | 2;
  passed: boolean;
  release: boolean;
  findings: CliFinding[];
  errors: string[];
}

/** argv 不含 node 与脚本路径（即 process.argv.slice(2)）；返回退出码。 */
export async function main(argv: readonly string[]): Promise<number> {
  void argv;
  throw new Error('NotImplemented: main');
}
