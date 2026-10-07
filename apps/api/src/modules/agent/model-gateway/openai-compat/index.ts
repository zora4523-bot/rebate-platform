// ModelGateway 第二段：OpenAI 兼容协议层与 HTTP 传输（05 B3-02b）。
// 依据：08 BR-AI-14 细则「多厂商接入」「路由顺序」（取值只在 08）；02 §9.2「模型路由」「前缀缓存」、§12.6；
// 09 CAP-X-07、CAP-X-19 的文档结论（未实测：显式缓存、内容拦截码等未实测特性一律做成差异表开关）。
// 不引入厂商 SDK、不加依赖：只用注入的 fetch 与自写 SSE 解析。apiKey 由接线层注入，值不进日志、错误与录制。
// 对齐评测：buildModelRequest 的产物与 packages/evals 的 ModelRequest 同形，录制键 = evals modelKey(产物)。
// 不在本段：路由与熔断（B3-02c）、无模型降级（B3-02d）、脱敏（B3-05）、工具循环（B3-05）。
// 规则测试在 test/spec/agent/model-openai-compat/。
// TODO(规划/11 §6): 百炼 / GLM 真实调用 — blocked on 负责人提供 key 与供应商登记（06 Q-C21、Q-C31）
import type { VendorId, VendorRequest, VendorTransport, VendorUsage } from '../vendors/index.ts';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface AssembledToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  /** assistant 回放上一轮的工具调用。 */
  readonly tool_calls?: readonly AssembledToolCall[];
  /** role=tool 时必填。 */
  readonly tool_call_id?: string;
}

export interface ChatInput {
  readonly vendor: VendorId;
  /** 锁定的日期快照（BR-AI-14 路由顺序；05 B3-02 快照锁定）。 */
  readonly model: string;
  /** 固定前缀（提示词正文在私有库，这里只收文本）。 */
  readonly system: string;
  readonly tools: readonly ToolDefinition[];
  /** 不含 system；用户文本已脱敏（B3-05）。 */
  readonly messages: readonly ChatMessage[];
  readonly sampling?: Readonly<{
    temperature?: number;
    top_p?: number;
    seed?: number;
    max_tokens?: number;
  }>;
}

/** 与 packages/evals 的 ModelRequest 同形（字段与可变性一致）：录制键 = evals modelKey(本对象)。 */
export interface ModelRequestShape {
  vendor: string;
  model: string;
  messages: unknown[];
  tools: unknown[];
  params: Record<string, unknown>;
}

/** 厂商差异表。默认值只取 09 文档结论；未实测的特性默认关或为空，可按型号覆盖。 */
export interface VendorQuirks {
  /** disable：发 enable_thinking=false；omit：不发该键（GLM-5.3 不能关思考，CAP-X-19）。 */
  readonly thinking: 'disable' | 'omit';
  /** 显式缓存（cache_control）；逐个型号核实后才开（CAP-X-07）。 */
  readonly explicitCache: boolean;
  /** stream_options.include_usage。 */
  readonly includeUsage: boolean;
  /** 快照锁定判定。 */
  readonly pinnedModel: RegExp;
  /** 厂商内容拦截码；未实测前为空。 */
  readonly contentRefusalCodes: readonly string[];
}

export type ModelEvent =
  | { readonly t: 'text_delta'; readonly text: string }
  | { readonly t: 'tool_call'; readonly index: number; readonly call: AssembledToolCall }
  | {
      readonly t: 'usage';
      readonly input: number;
      readonly output: number;
      readonly cached: number | null;
    }
  | { readonly t: 'done'; readonly reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' };

export type ModelErrorKind =
  | 'content_refused'
  | 'auth'
  | 'bad_request'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'server'
  | 'timeout'
  | 'network'
  | 'aborted'
  | 'malformed'
  | 'model_not_pinned';

export type ModelFailure =
  | { readonly status: number; readonly body: unknown }
  | { readonly cause: 'timeout' | 'network' | 'aborted' };

export class ModelProtocolError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;
  readonly vendorCode: string | null;

  constructor(
    kind: ModelErrorKind,
    message: string,
    detail?: { status?: number | null; vendorCode?: string | null },
  ) {
    super('NotImplemented: ModelProtocolError');
    void kind;
    void message;
    void detail;
    throw new Error('NotImplemented: ModelProtocolError');
  }
}

export function quirksFor(
  vendor: VendorId,
  overrides?: Partial<Omit<VendorQuirks, 'pinnedModel'>>,
): VendorQuirks {
  void vendor;
  void overrides;
  throw new Error('NotImplemented: quirksFor');
}

/** 不是锁定快照时抛 ModelProtocolError('model_not_pinned')。 */
export function assertPinnedModel(model: string, quirks: VendorQuirks): void {
  void model;
  void quirks;
  throw new Error('NotImplemented: assertPinnedModel');
}

export function buildModelRequest(input: ChatInput, quirks: VendorQuirks): ModelRequestShape {
  void input;
  void quirks;
  throw new Error('NotImplemented: buildModelRequest');
}

/** body = { model, messages, tools, ...params }。 */
export function toVendorRequest(req: ModelRequestShape): VendorRequest {
  void req;
  throw new Error('NotImplemented: toVendorRequest');
}

export function fromVendorRequest(req: VendorRequest): ModelRequestShape {
  void req;
  throw new Error('NotImplemented: fromVendorRequest');
}

/** 流式分片拼装成统一事件；畸形输入抛 ModelProtocolError('malformed')。 */
export function assembleChunks(chunks: readonly unknown[]): ModelEvent[] {
  void chunks;
  throw new Error('NotImplemented: assembleChunks');
}

export function usageOf(events: readonly ModelEvent[]): VendorUsage {
  void events;
  throw new Error('NotImplemented: usageOf');
}

export function classifyFailure(
  vendor: VendorId,
  failure: ModelFailure,
  quirks: VendorQuirks,
): ModelErrorKind {
  void vendor;
  void failure;
  void quirks;
  throw new Error('NotImplemented: classifyFailure');
}

export interface SseChunkParser {
  push(text: string): unknown[];
  end(): unknown[];
  readonly finished: boolean;
}

export function createSseChunkParser(): SseChunkParser {
  throw new Error('NotImplemented: createSseChunkParser');
}

export interface FetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface FetchResponseLike {
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array> | null;
  text(): Promise<string>;
}

export interface FetchLike {
  (url: string, init: FetchInit): Promise<FetchResponseLike>;
}

export interface HttpTransportOptions {
  readonly vendor: VendorId;
  /** https，来自配置文件，不带凭据与查询串。 */
  readonly baseUrl: string;
  /** 接线层从 KMS / 环境变量取；每次请求时调用；值不进日志、错误、录制。 */
  readonly apiKey: () => string;
  /** 生产传 globalThis.fetch。 */
  readonly fetch: FetchLike;
  readonly quirks: VendorQuirks;
}

/** billable=true。 */
export function createHttpTransport(options: HttpTransportOptions): VendorTransport {
  void options;
  throw new Error('NotImplemented: createHttpTransport');
}

/** 把评测端口（evals AgentPorts.model）包成传输；billable=false。 */
export function createPortTransport(
  model: (req: ModelRequestShape) => Promise<unknown>,
): VendorTransport {
  void model;
  throw new Error('NotImplemented: createPortTransport');
}
