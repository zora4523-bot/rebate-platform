// 发布制品扫描第三段：Release 制品里的调试能力与测试环境残留（规划/03 §3.6「发布制品扫描」；02 §12.6 末句；
// 05 QA-09 后半句；10 AC-S1-86 ①②）。任何一项命中即阻断发布；残留命中不经公开标识清单比对，不设豁免。
// 口径由规则测试 test/spec/release-scan/residue/** 逐条约束（规则表见 detect.test.ts 文件头）。
// QA-09c 骨架：只抛 NotImplemented，由实现任务补全。

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
  void routesJson;
  throw new Error('NotImplemented: debugOnlyRoutes');
}

/** 对一个制品条目跑全部残留规则；二进制 AndroidManifest（AXML）按解析视图检测，损坏时抛错。 */
export function detectResidue(
  file: string,
  content: string | Uint8Array,
  options: ResidueOptions,
): ResidueHit[] {
  void file;
  void content;
  void options;
  throw new Error('NotImplemented: detectResidue');
}
