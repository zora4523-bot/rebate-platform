// ModelGateway 第一段（05 B3-02a）：厂商适配器接口、厂商登记、录制回放传输。
// 依据：08 BR-AI-14 细则「多厂商接入」（取值只在 08）、02 §9.2 模型路由、§9.3 回放模式、§12.7。
// 只登记规划已登记的厂商：千问（百炼，09 CAP-X-07）与智谱 GLM（只离线，09 CAP-X-19）。
// 本段只有 NotImplemented 骨架；规则测试在 test/spec/agent/model-vendors/。
// TODO(规划/11 §6): 百炼 / GLM 真实调用（live 传输）— blocked on 负责人提供 key 与供应商登记（06 Q-C21、Q-C31）
import type { Clock } from '../../../platform/index.ts';

/** 已登记的厂商（BR-AI-14 多厂商接入）。新增厂商须负责人点名并先在 09 登记能力验证条目。 */
export type VendorId = 'qwen' | 'glm';

/** 线上 = 处理用户输入；离线 = 评测对照、评审打分、提示词改写、生成合成评测题。 */
export type VendorPurpose = 'online' | 'offline';

/** 离线用途的四种用法（BR-AI-14 多厂商接入）。 */
export type OfflineUse =
  'eval_compare' | 'review_scoring' | 'prompt_rewrite' | 'synthetic_eval_gen';

/** 接入路径：百炼 OpenAI 兼容（路径 A）；智谱开放平台直连（路径 B，09 CAP-X-19）。 */
export type AccessPath = 'bailian' | 'zhipu_open';

/** 能力验证条目（09）。 */
export type CapabilityRef = 'CAP-X-07' | 'CAP-X-19';

/**
 * 调用方声明的输入数据来源。离线只接受 synthetic / public_product / prompt；
 * rewritten_sample（真实对话脱敏并人工改写的评测样本及其衍生物）须有按接入路径与用途登记的外发许可；
 * owner_aggregate（由负责人提供的聚合统计写成的评测题，06 Q-D4）千问可用，其他厂商须负责人批准。
 */
export type DataClass =
  | 'user_input'
  | 'production'
  | 'synthetic'
  | 'public_product'
  | 'prompt'
  | 'rewritten_sample'
  | 'owner_aggregate';

/** 离线调用可声明的数据来源（类型层不含 user_input / production）。 */
export type OfflineDataClass = Exclude<DataClass, 'user_input' | 'production'>;

/** 类型层只允许线上登记的厂商进入线上调用（运行时另有 assertOnlineVendor）。 */
export type OnlineVendorId = 'qwen';

export interface VendorRegistration {
  vendor: VendorId;
  purposes: readonly VendorPurpose[];
  accessPaths: readonly AccessPath[];
  capability: CapabilityRef;
  /** 离线付费调用之前须由负责人定月度上限与试跑额度（06 Q-C31）。 */
  offlineBudgetRequired: boolean;
}

/** 发给厂商的请求；body 是不透明的 OpenAI 兼容报文（报文拼装属 B3-02b）。 */
export interface VendorRequest {
  vendor: VendorId;
  model: string;
  body: unknown;
}

export interface VendorUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface VendorResponse {
  /** 流式分片原样返回（拼装属 B3-02b）。 */
  chunks: readonly unknown[];
  usage: VendorUsage;
}

/** 厂商传输。billable=false 表示不产生费用（录制回放）。 */
export interface VendorTransport {
  readonly billable: boolean;
  /** signal 由网关原样转交；已取消的 signal 不得发出请求。 */
  send(request: VendorRequest, signal?: AbortSignal): Promise<VendorResponse>;
}

/** 合成录制（公开仓库只放合成样例，02 §9.3、§12.7）。 */
export interface VendorRecording {
  synthetic: true;
  vendor: VendorId;
  model: string;
  request: unknown;
  response: VendorResponse;
}

export interface OnlineVendorCall {
  purpose: 'online';
  vendor: OnlineVendorId;
  model: string;
  dataClass: DataClass;
  body: unknown;
}

export interface OfflineVendorCall {
  purpose: 'offline';
  vendor: VendorId;
  use: OfflineUse;
  /** 接入平台（BR-AI-14：外发许可按厂商、接入平台、业务空间、模型与用途分别登记）。 */
  accessPath: AccessPath;
  /** 业务空间标识（合成值）。 */
  workspace: string;
  model: string;
  dataClass: OfflineDataClass;
  body: unknown;
}

/**
 * 改写样本外发许可（一条许可对应一个具体接入路径与用途，新增或变更不继承）。
 * noTrainingConfirmed：厂商书面确认不用于训练（千问 06 Q-G10、其他 06 Q-G19）；
 * legalApproved：千问以外厂商另须法务同意。
 */
export interface RewrittenSampleGrant {
  vendor: VendorId;
  accessPath: AccessPath;
  workspace: string;
  model: string;
  use: OfflineUse;
  noTrainingConfirmed: boolean;
  legalApproved: boolean;
}

/** 负责人对「聚合统计写成的评测题发给千问以外厂商」的批准（处理标准与批准记录）。 */
export interface OwnerAggregateApproval {
  vendor: VendorId;
  approvalRecord: string;
}

export type VendorCall = OnlineVendorCall | OfflineVendorCall;

/** 计量记录：线上进日预算计量（BR-AI-16），离线按厂商独立计量，两者不混。 */
export interface UsageEntry {
  vendor: VendorId;
  purpose: VendorPurpose;
  use: OfflineUse | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  recorded_at: Date;
}

export interface UsageSink {
  record(entry: UsageEntry): void;
}

export interface VendorGatewayOptions {
  transport: VendorTransport;
  clock: Clock;
  onlineMeter: UsageSink;
  offlineMeter: UsageSink;
  /** 负责人已定离线额度的厂商（06 Q-C31）；未列入的、需要额度的厂商不得发生付费离线调用。 */
  offlineBudgetApproved: readonly VendorId[];
  rewrittenSampleGrants: readonly RewrittenSampleGrant[];
  ownerAggregateApprovals: readonly OwnerAggregateApproval[];
}

export interface VendorGateway {
  /** signal 原样转交传输；调用前已取消则不调传输，以 aborted 结束。 */
  invoke(call: VendorCall, signal?: AbortSignal): Promise<VendorResponse>;
}

export type VendorErrorCode =
  | 'vendor_unknown'
  | 'vendor_not_online'
  | 'purpose_not_registered'
  | 'data_class_not_allowed'
  | 'rewritten_sample_not_allowed'
  | 'no_training_unconfirmed'
  | 'legal_approval_missing'
  | 'owner_aggregate_not_approved'
  | 'aborted'
  | 'offline_budget_unset'
  | 'recording_miss'
  | 'recording_invalid'
  | 'recording_has_secret';

export class VendorError extends Error {
  readonly code!: VendorErrorCode;

  constructor(code: VendorErrorCode, message: string) {
    super('NotImplemented');
    void code;
    void message;
    throw new Error('NotImplemented: VendorError');
  }
}

/** 厂商登记表（只含规划已登记的厂商）。 */
export function vendorRegistry(): readonly VendorRegistration[] {
  throw new Error('NotImplemented: vendorRegistry');
}

/** 运行时拦截：未登记或未登记线上用途的厂商一律拒绝。 */
export function assertOnlineVendor(vendor: string): OnlineVendorId {
  void vendor;
  throw new Error('NotImplemented: assertOnlineVendor');
}

/** 网关：按登记校验用途、数据来源与离线额度，经传输调用，按用途分开计量。 */
export function createVendorGateway(options: VendorGatewayOptions): VendorGateway {
  void options;
  throw new Error('NotImplemented: createVendorGateway');
}

/** 录制回放传输：按 vendor + model + body（键序无关）精确匹配；未命中即报错，不回落到真实调用。 */
export function createReplayTransport(recordings: readonly VendorRecording[]): VendorTransport {
  void recordings;
  throw new Error('NotImplemented: createReplayTransport');
}

/** 校验一条录制：必须是合成、厂商已登记、不带鉴权或密钥字段。 */
export function parseVendorRecording(value: unknown): VendorRecording {
  void value;
  throw new Error('NotImplemented: parseVendorRecording');
}

/** 读取目录下全部 *.json 录制（每个文件一条），逐条校验。 */
export async function loadVendorRecordings(dir: string): Promise<VendorRecording[]> {
  void dir;
  throw new Error('NotImplemented: loadVendorRecordings');
}

/** 本目录 __fixtures__ 的绝对路径（只放合成录制）。 */
export function vendorFixturesDir(): string {
  throw new Error('NotImplemented: vendorFixturesDir');
}
