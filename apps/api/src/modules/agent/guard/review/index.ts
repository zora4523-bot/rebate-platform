import type { RootLogger, Scheduler } from '../../../platform/index.ts';
import type { SentenceReviewPort } from '../index.ts';

// B3-06b · BR-AI-18 · 文档差异表，尚无真实调用能力验证（09 U-79）。
// https://help.aliyun.com/zh/document_detail/2671445.html
// 默认：Code=200、Data.RiskLevel；none 通过，high/medium/low 均有风险，按 BR-AI-18 拦截。
// 未知字段/值、非成功状态或异常均为 timeout；不得将 Advice 中的文本当作审核结果。
// TODO(规划/11 §6): 真实调用验证 — blocked on 负责人开通阿里云内容安全并提供 Key。
export interface AliyunReviewDifferences {
  readonly inputService: string;
  readonly outputService: string;
  readonly codePath: readonly string[];
  readonly successCode: number;
  readonly verdictPath: readonly string[];
  readonly passValues: readonly string[];
  readonly blockValues: readonly string[];
}

export interface AliyunCredentials {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly securityToken?: string;
}

/** 签名器只返回请求头；不允许它改变出站地址、方法或正文。时间与 nonce 由接线注入。 */
export interface AliyunSignRequest {
  readonly endpoint: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  /** RPC form：Service 与 JSON 字符串 ServiceParameters（content 保持原文）。 */
  readonly body: string;
  readonly action: 'TextModerationPlus';
  readonly version: '2022-03-02';
}

export interface AliyunReviewFetchInit {
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly redirect: 'error';
}

/** 仿 B3-02b FetchLike 的最小非流式形状；生产可注入 globalThis.fetch。 */
export interface AliyunReviewFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export interface AliyunReviewFetch {
  (url: string, init: AliyunReviewFetchInit): Promise<AliyunReviewFetchResponse>;
}

export interface AliyunReviewDeps {
  readonly fetch: AliyunReviewFetch;
  readonly scheduler: Scheduler;
  /** 每次 review 读取一次 agent.safety.timeout_ms；默认 1000ms 由配置层提供。 */
  readonly timeoutMs: () => number;
  readonly credentials: () => AliyunCredentials;
  readonly sign: (
    request: AliyunSignRequest,
    credentials: AliyunCredentials,
    signal: AbortSignal,
  ) => Promise<Readonly<Record<string, string>>>;
  /** 配置的完整 HTTPS 地址；不拼接其他地址，不跟随跳转。 */
  readonly endpoint: string;
  readonly differences?: AliyunReviewDifferences;
  /** 只允许平铺的诊断字段；不记录凭据、正文或原始异常。 */
  readonly logger?: Pick<RootLogger, 'debug' | 'info' | 'warn' | 'error'>;
}

export function defaultAliyunReviewDifferences(): AliyunReviewDifferences {
  throw new Error('NotImplemented: defaultAliyunReviewDifferences');
}

export function createAliyunInputReview(deps: AliyunReviewDeps): SentenceReviewPort {
  void deps;
  throw new Error('NotImplemented: createAliyunInputReview');
}

export function createAliyunOutputReview(deps: AliyunReviewDeps): SentenceReviewPort {
  void deps;
  throw new Error('NotImplemented: createAliyunOutputReview');
}
