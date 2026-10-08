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
// - QA-09e：密钥检测走 QA-09d 的关联视图（detect/association.ts：.apk resources.arsc / AXML、
//   .aab resources.pb / proto 清单、.hap module.json / resources.index），视图的 resourceNames、
//   rawStrings 标志原样交给检测；签名字段引用解析不了、结构损坏即读取失败（退出码 2）。
//   --release 的残留检测对 .aab proto 清单另读同一关联视图（可调试标志）。
// - 只经 process.stdout.write / process.stderr.write 输出，不用 console；main 不调用 process.exit。
import { lstat, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareHits } from './compare/index.ts';
import { artifactTextViews, readArtifact } from './detect/index.ts';
import type { ScanHit } from './detect/index.ts';
import { detectText } from './detect/rules.ts';
import {
  debugOnlyRoutes,
  detectResidue,
  readApprovals,
  readArguments,
  stripApplePlistDoctype,
} from './residue/index.ts';

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
  const report: CliReport = {
    exit_code: 2,
    passed: false,
    release: argv.includes('--release'),
    findings: [],
    errors: [],
  };
  // 不转发底层异常 message：解析器、文件路径、参数都可能包含敏感原文。
  let stage = 'Invalid scan arguments';
  try {
    const args = readArguments(argv);
    stage = 'Cannot read scan manifest or approvals';
    const [manifestYaml, approvalsYaml] = await Promise.all([
      readFile(args.manifest, 'utf8'),
      readFile(args.approvals, 'utf8'),
    ]);
    stage = 'Invalid approvals';
    const approvals = readApprovals(approvalsYaml);
    let debugRoutes: string[] | undefined;
    if (args.release) {
      try {
        debugRoutes = debugOnlyRoutes(await readFile(args.routes, 'utf8'));
      } catch {
        report.errors.push('Cannot read or parse debug routes');
      }
    }
    stage = 'Cannot read artifact';
    const stat = await lstat(args.path);
    const extensions: Readonly<Record<string, string>> = {
      '.ipa': 'ios',
      '.apk': 'android',
      '.aab': 'android',
      '.hap': 'harmony',
      '.app': 'harmony',
    };
    const matches = stat.isDirectory()
      ? args.platform === 'h5' || args.platform === 'admin'
      : extensions[extname(args.path).toLowerCase()] === args.platform;
    if (!matches) report.errors.push('Artifact does not match requested platform');
    const artifact = await readArtifact(args.path);
    if (artifact.errors.length > 0) report.errors.push('Artifact could not be read completely');
    const hits: ScanHit[] = [];
    // 同一关联语义（与 scanArtifact 一致）：清单引用经同一包的资源表解析；读不了的条目记读取错误，
    // 其他条目照常检测。错误原文含条目路径，不转发，只报固定文案。
    const associated = artifactTextViews(artifact.entries);
    if (associated.errors.length > 0)
      report.errors.push('Artifact content unreadable or signing reference unresolved');
    const fieldViews = new Map<string, string[]>();
    // 原值视图紧跟来源视图；同一条目已按同一规则报过的同一取值，原值视图里的 high-entropy 不重复报。
    const reported = new Map<string, Set<string>>();
    for (const view of associated.views) {
      if (view.rawStrings !== true) {
        const list = fieldViews.get(view.path);
        if (list) list.push(view.text);
        else fieldViews.set(view.path, [view.text]);
      }
      let seen = reported.get(view.path);
      if (!seen) reported.set(view.path, (seen = new Set()));
      try {
        const found = detectText(
          view.path,
          stripApplePlistDoctype(view.text),
          args.thresholds,
          view.resourceNames === true,
          view.rawStrings === true,
        );
        for (const hit of found) {
          const key = `${hit.rule}\u0000${hit.match}`;
          if (view.rawStrings === true && hit.rule === 'high-entropy' && seen.has(key)) continue;
          seen.add(key);
          hits.push(hit);
        }
      } catch {
        report.errors.push('Cannot parse artifact content for secret scanning');
      }
    }
    for (const entry of artifact.entries) {
      if (debugRoutes !== undefined) {
        try {
          const views = fieldViews.get(entry.path);
          for (const hit of detectResidue(entry.path, entry.content, {
            debugRoutes,
            ...(views ? { views } : {}),
          })) {
            report.findings.push({
              kind: 'residue',
              rule: hit.rule,
              file: hit.file,
              line: hit.line,
              verdict: 'block',
            });
          }
        } catch {
          report.errors.push('Cannot parse artifact content for residue scanning');
        }
      }
    }
    stage = 'Cannot compare secret findings';
    const compared = compareHits({ manifestYaml, approvals, platform: args.platform, hits });
    if (compared.errors.length > 0) report.errors.push('Invalid public identifier manifest');
    for (const { hit, verdict } of compared.decisions) {
      report.findings.push({
        kind: 'secret',
        rule: hit.rule,
        file: hit.file,
        line: hit.line,
        verdict,
      });
    }
    report.exit_code =
      report.errors.length > 0 || compared.exit_code === 2
        ? 2
        : report.findings.some((hit) => hit.verdict === 'block')
          ? 1
          : 0;
    report.passed = report.exit_code === 0;
  } catch {
    report.errors.push(stage);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.exit_code;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
