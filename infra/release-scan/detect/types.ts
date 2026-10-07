import type { ApprovalRecord, ClientPlatform, CompareReport, ScanHit } from '../compare/types.ts';

export type { ApprovalRecord, ClientPlatform, CompareReport, ScanHit } from '../compare/types.ts';

export type DetectRuleId =
  | 'private-key'
  | 'request-sign-material'
  | 'server-secret'
  | 'aliyun-access-key'
  | 'credential-url'
  | 'keyed-credential'
  | 'high-entropy';

export interface DetectOptions {
  minLength: number;
  minEntropy: number;
}

export interface ArtifactEntry {
  /** 相对路径；嵌套制品使用「包路径/条目路径」。 */
  path: string;
  content: Uint8Array;
}

export interface ReadResult {
  entries: ArtifactEntry[];
  errors: string[];
}

export interface ScanInput {
  path: string;
  platform: ClientPlatform;
  /** 调用方从可信来源提供的公开标识清单与批准记录。 */
  manifestYaml: string;
  approvals: readonly ApprovalRecord[];
  options?: Partial<DetectOptions>;
}

export interface ScanResult {
  platform: ClientPlatform;
  hits: ScanHit[];
  report: CompareReport;
  errors: string[];
  /** 0 = 放行；1 = 阻断；2 = 读取错误或清单无效。 */
  exit_code: 0 | 1 | 2;
  passed: boolean;
}
