import type { Clock } from '../../../platform/index.ts';
import type {
  AccessPath,
  OfflineDataClass,
  OfflineUse,
  UsageSink,
  VendorGateway,
  VendorId,
  VendorResponse,
} from '../vendors/index.ts';
import { VendorError } from '../vendors/index.ts';
import type { ModelRequestShape } from '../openai-compat/index.ts';
import { ModelProtocolError, toVendorRequest } from '../openai-compat/index.ts';
import { gatewayBilling } from './billing.ts';

/** 来源由可信评测加载器附加；旧合成题可省略，不得取自模型输出、正文或用户请求。 */
export interface EvalModelRequest extends ModelRequestShape {
  readonly provenance?: string;
  readonly dataClass?: OfflineDataClass;
}

export type EvalFailureMetering =
  | { readonly billable: false }
  | { readonly billable: true; readonly offlineMeter: UsageSink; readonly clock: Clock };

export interface EvalModelPortOptions {
  readonly gateway: VendorGateway;
  readonly vendor: VendorId;
  readonly model: string;
  readonly use: OfflineUse;
  readonly accessPath: AccessPath;
  readonly workspace: string;
  /**
   * 兼容旧接线，仍校验配置形状与登记的 billable 是否一致。
   * 成功和失败用量均由 gateway 按自身 transport、计量去处与 Clock 记录。
   */
  readonly metering?: EvalFailureMetering;
}

function provenanceClass(provenance: string): OfflineDataClass {
  switch (provenance) {
    case 'synthetic':
    case 'vendor_synthetic':
      return 'synthetic';
    case 'rewritten':
      return 'rewritten_sample';
    case 'aggregated_stats':
      return 'owner_aggregate';
    default:
      // real_link_sample 未证明仅含公开商品数据，不能自动放行。
      throw new VendorError('data_class_not_allowed', 'Unsupported evaluation provenance');
  }
}

function evaluationDataClass(req: EvalModelRequest): OfflineDataClass {
  // 兼容未附来源的合成评测；任何显式来源仍须通过识别、冲突检查和网关许可闸。
  if (req.provenance === undefined && req.dataClass === undefined) return 'synthetic';
  const fromProvenance = req.provenance === undefined ? undefined : provenanceClass(req.provenance);
  const dataClass = req.dataClass === undefined ? fromProvenance : req.dataClass;
  if (
    dataClass === undefined ||
    !['synthetic', 'public_product', 'prompt', 'rewritten_sample', 'owner_aggregate'].includes(
      dataClass,
    ) ||
    (fromProvenance !== undefined && fromProvenance !== dataClass)
  ) {
    throw new VendorError(
      'data_class_not_allowed',
      'Unsupported or conflicting evaluation data class',
    );
  }
  return dataClass;
}

function invalidMetering(): ModelProtocolError {
  return new ModelProtocolError('bad_request', 'Invalid evaluation metering configuration');
}

/** 保留旧接线的构造校验，端口不再补记或认领失败用量。 */
function validateMetering(options: EvalModelPortOptions): void {
  const registered = gatewayBilling(options.gateway);
  const declared = options.metering;
  if (declared !== undefined) {
    const billable: unknown = declared.billable;
    if (
      typeof billable !== 'boolean' ||
      (declared.billable &&
        (typeof declared.offlineMeter?.record !== 'function' ||
          typeof declared.clock?.now !== 'function')) ||
      (registered !== undefined && registered.billable !== billable)
    ) {
      throw invalidMetering();
    }
  }
}

export function createEvalModelPort(
  options: EvalModelPortOptions,
): (req: EvalModelRequest) => Promise<VendorResponse> {
  const config = { ...options };
  // 构造即校验，配置错误不等到第一次调用。
  validateMetering(options);
  return async (req) => {
    if (req.vendor !== config.vendor || req.model !== config.model) {
      throw new ModelProtocolError('bad_request', 'Evaluation request does not match its port');
    }
    const dataClass = evaluationDataClass(req);
    const request = toVendorRequest(req);
    return config.gateway.invoke({
      ...request,
      vendor: config.vendor,
      model: config.model,
      purpose: 'offline',
      use: config.use,
      accessPath: config.accessPath,
      workspace: config.workspace,
      dataClass,
    });
  };
}
