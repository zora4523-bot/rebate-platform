// 发布制品扫描第一段：把检测命中项与 specs/client-public-ids.yaml 比对，出报告与退出码
// （规划/02 §12.6「安装包里只放公开标识」与放行两类、不可豁免；05 QA-09；BR-ID-09 请求签名材料与共享盐不得内置）。
// 检测规则、制品解包与命令行入口在 QA-09b（infra/release-scan/detect/**、cli.ts）。
// 清单文件不写取值：「类别 → 格式」对照表写在本段实现里（plan.md Q8）；YAML 只用 tools/lib/yaml-lite.ts 解析。
// 判定顺序：never_accepted → 公开标识（类别格式 + 所在端）→ false_positives（rule + file 全等）→
// exceptions（rule + file 全等，且 approval 指向 ops/approvals.yaml 里 granted 为 true 的批准）→ 其余阻断。

/** contracts/enums/platform.yaml client_platform。 */
export type ClientPlatform = 'ios' | 'android' | 'harmony' | 'h5' | 'admin';

/** 02 §12.6 公开标识表的八个类别。 */
export type PublicIdCategory =
  | 'request_routing'
  | 'wechat'
  | 'system_capability'
  | 'huawei'
  | 'push_client'
  | 'union_sdk'
  | 'crash_report'
  | 'config_verification';

/** 检测段（QA-09b）交来的一条命中。 */
export interface ScanHit {
  /** 命中的检测规则编号。 */
  rule: string;
  /** 制品内的相对路径（解包后），用 `/` 分隔。 */
  file: string;
  line: number;
  /** 命中的原文（整段匹配）。 */
  match: string;
  /** 检测规则判定为 02 §12.6 服务端密钥、私钥、请求签名材料或共享盐（不可豁免）。 */
  never_accepted: boolean;
}

/** ops/approvals.yaml 中的一条批准（只用到这两个字段）。 */
export interface ApprovalRecord {
  id: number;
  granted: boolean;
}

export interface CompareInput {
  /** specs/client-public-ids.yaml 的原文。 */
  manifestYaml: string;
  /** ops/approvals.yaml 的 approvals 列表（由调用方从可信副本读出）。 */
  approvals: readonly ApprovalRecord[];
  /** 被扫描制品所属的端。 */
  platform: ClientPlatform;
  hits: readonly ScanHit[];
}

export type DecisionReason =
  | 'never_accepted'
  | 'public_id'
  | 'false_positive'
  | 'exception'
  | 'exception_unapproved'
  | 'unlisted'
  | 'manifest_invalid';

export interface HitDecision {
  hit: ScanHit;
  verdict: 'allow' | 'block';
  reason: DecisionReason;
  /**
   * 放行依据：public_id 为清单条目 id；false_positive 为 `false_positives[<下标>]`；
   * exception 为 `exceptions[<下标>]`；阻断时为 null。
   */
  basis: string | null;
}

export interface CompareReport {
  platform: ClientPlatform;
  /** 0 = 全部放行；1 = 有阻断；2 = 清单无效（全部阻断）。 */
  exit_code: 0 | 1 | 2;
  passed: boolean;
  /** 与输入 hits 同序、一一对应。 */
  decisions: HitDecision[];
  /** 清单错误说明；清单有效时为空数组。 */
  errors: string[];
  summary: { total: number; allowed: number; blocked: number };
}

export function compareHits(input: CompareInput): CompareReport {
  void input;
  throw new Error('NotImplemented: compareHits');
}
