// 发布制品扫描第二段：制品读取、密钥检测规则与可调用的扫描函数
// （规划/02 §12.6「安装包里只放公开标识」「发布制品密钥扫描」；05 QA-09；BR-ID-09 安装包不内置签名密钥或共享盐）。
// 只用 Node 内置模块（zip 解包用 node:zlib），不调 gitleaks 二进制（plan.md Q9）；规则里不写任何密钥值。
// 比对、报告与退出码复用 QA-09a（../compare/index.ts 的 compareHits），本段不改它；命令行入口 cli.ts 归 QA-09c。
//
// 口径（规则测试 test/spec/release-scan/detect/** 逐条约束）：
// - 制品：.ipa → ios；.apk / .aab → android；.hap / .app → harmony，按 zip 解包（stored、deflate，
//   支持数据描述符，以中央目录为准）；包内 .hap / .hsp / .apk / .aab / .jar / .aar / .zip 条目继续解包，
//   路径写作「内层制品路径/内层条目路径」，内层制品本身不再当文本扫描。目录 → h5 / admin，递归遍历
//   （含点开头的文件），路径相对根目录、用 `/` 分隔；遇到符号链接报错、不跟随。
// - 读不了的一律报错（扩展名不认识、端与制品不符、路径不存在、zip 损坏、不支持的压缩方式、加密条目），
//   有错误时退出码为 2（fail-closed），已读到的命中照常比对、照常列出。
// - 带 BOM（FF FE / FE FF）的条目按 UTF-16LE / UTF-16BE 解码；其余按 latin1 解码成文本再检测（二进制里的
//   ASCII 串也能命中），并另提取无 BOM 的 UTF-16LE 可打印串一并检测；行号从 1 起、按解码后的 `\n` 计。
// - 二进制 plist（bplist00）必须解析：键值按同一规则检测；不含密钥的二进制 plist 读通、不报错（真实 ipa 的
//   Info.plist 默认是二进制 plist）；只有读不通的损坏 bplist 记入 errors（退出码 2）。
// - 二进制 AndroidManifest（AXML）、dex 等不含密钥的二进制条目不得误报、不得报错。
// - 规则与是否不可豁免（never_accepted）：private-key、request-sign-material、server-secret、
//   aliyun-access-key、credential-url 为不可豁免；keyed-credential、high-entropy 交比对段按清单判定。
//   同一段文字只报一次：与先报规则的命中范围重叠的，按上面的顺序只留最先的规则；私钥块、公钥块、
//   URL 内的高熵串分别并为一条命中。
// - 签名材料字段（BR-ID-09）不套用通用过滤：任何非空取值都报，不看长度、不要求数字、不看熵、可含标点，
//   取值到配对的引号、`<` 或空白为止；salt 后跟 rounds / length / len / size / bits / count / iterations /
//   cost 的字段是算法参数、不算签名材料。server-secret 与 keyed-credential 的取值为 ≥ 16 位且含数字。
// - 高熵候选串是最长连续的 [A-Za-z0-9+/=_-]（'-'、'_' 不切段）。
// - 高熵串：长度 ≥ minLength、同时含字母与数字、香农熵（bit / 字符）≥ minEntropy；两个阈值可配置。

import { lstat } from 'node:fs/promises';
import { compareHits } from '../compare/index.ts';
import type { ApprovalRecord, ClientPlatform, CompareReport, ScanHit } from '../compare/index.ts';
import { textViews } from './encoding.ts';
import { artifactPlatform, readArtifact } from './read.ts';
import { detectText, resolveOptions } from './rules.ts';

export { readArtifact } from './read.ts';
export { defaultDetectOptions, shannonEntropy } from './rules.ts';

export type { ApprovalRecord, ClientPlatform, CompareReport, ScanHit } from '../compare/index.ts';

/** 检测规则编号（写进 ScanHit.rule）。 */
export type DetectRuleId =
  | 'private-key'
  | 'request-sign-material'
  | 'server-secret'
  | 'aliyun-access-key'
  | 'credential-url'
  | 'keyed-credential'
  | 'high-entropy';

/** 高熵规则的阈值。 */
export interface DetectOptions {
  /** 候选串的最短长度（字符数，含）。 */
  minLength: number;
  /** 香农熵下限（bit / 字符，含）。 */
  minEntropy: number;
}

/** 制品里的一个文件（解包或遍历后）。 */
export interface ArtifactEntry {
  /** 相对路径，用 `/` 分隔；嵌套制品写作「内层制品路径/内层条目路径」。 */
  path: string;
  content: Uint8Array;
}

export interface ReadResult {
  entries: ArtifactEntry[];
  /** 读取错误；为空表示整个制品都读到了。 */
  errors: string[];
}

export interface ScanInput {
  /** 制品文件（.ipa / .apk / .aab / .hap / .app）或构建产物目录。 */
  path: string;
  platform: ClientPlatform;
  /** specs/client-public-ids.yaml 原文。 */
  manifestYaml: string;
  /** ops/approvals.yaml 的批准列表（调用方从可信副本读出）。 */
  approvals: readonly ApprovalRecord[];
  /** 覆盖高熵阈值；未给的项取 defaultDetectOptions()。 */
  options?: Partial<DetectOptions>;
}

export interface ScanResult {
  platform: ClientPlatform;
  /** 全部检测命中（与 report.decisions 同序）。 */
  hits: ScanHit[];
  /** QA-09a compareHits 的报告。 */
  report: CompareReport;
  /** 读取错误；非空时 exit_code 为 2。 */
  errors: string[];
  /** 0 = 全部放行；1 = 有阻断；2 = 读取错误或清单无效。 */
  exit_code: 0 | 1 | 2;
  passed: boolean;
}

/** 对一个文件的内容跑全部检测规则；file 原样写进命中的 file。 */
export function detectSecrets(
  file: string,
  content: string | Uint8Array,
  options?: Partial<DetectOptions>,
): ScanHit[] {
  const thresholds = resolveOptions(options);
  return textViews(content).flatMap((text) => detectText(file, text, thresholds));
}

/** 读取 + 检测 + 与公开标识清单比对（QA-09a compareHits）。 */
export async function scanArtifact(input: ScanInput): Promise<ScanResult> {
  const { entries, errors } = await readArtifact(input.path);
  const hits: ScanHit[] = [];
  try {
    const stat = await lstat(input.path);
    const matches = stat.isDirectory()
      ? input.platform === 'h5' || input.platform === 'admin'
      : artifactPlatform(input.path) === input.platform;
    if (!matches) errors.push('Artifact does not match requested platform');
  } catch {
    // readArtifact 已记录读取失败，仍比对已读到的部分。
  }
  let options: DetectOptions | undefined;
  try {
    options = resolveOptions(input.options);
  } catch {
    errors.push('Invalid detection thresholds');
  }
  if (options)
    for (const entry of entries) {
      try {
        hits.push(...detectSecrets(entry.path, entry.content, options));
      } catch {
        errors.push(`Artifact content unreadable: ${entry.path}`);
      }
    }
  const report = compareHits({
    manifestYaml: input.manifestYaml,
    approvals: input.approvals,
    platform: input.platform,
    hits,
  });
  const exit_code = errors.length > 0 ? 2 : report.exit_code;
  return { platform: input.platform, hits, report, errors, exit_code, passed: exit_code === 0 };
}
