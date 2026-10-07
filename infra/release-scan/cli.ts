// 发布制品扫描命令行入口（QA-09c 装配）：读取制品 → QA-09b 密钥检测 → QA-09a 白名单比对 →
// --release 时另跑 residue/ 残留规则（03 §3.6；残留命中一律阻断、不经清单豁免）。
//
// 用法：cli.ts <制品路径> --platform <ios|android|harmony|h5|admin> --manifest <清单 yaml>
//        --approvals <批准记录 yaml> [--release] [--routes <routes.json>]
//        [--min-length <整数>] [--min-entropy <数>]
// - --routes 缺省为本仓库 contracts/routes.json（按本文件位置解析，不按当前目录）。
// - 阈值只能调严（不高于 QA-09b 默认值），调松或不是数值即用法错误。
// - 退出码：0 通过；1 有阻断命中；2 用法错误或读取 / 解析失败（fail-closed）。
// - 标准输出写一份 JSON 报告；命中的密钥原文不得出现在标准输出与标准错误里（脱敏）。
// - 只经 process.stdout.write / process.stderr.write 输出，不用 console；main 不调用 process.exit。
// QA-09c 骨架：只抛 NotImplemented，由实现任务补全（作为脚本直接运行时的入口判断也由实现补上）。

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
