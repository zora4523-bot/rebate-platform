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

/** 来源由可信评测加载器附加，不得取自模型输出、消息正文或用户请求。 */
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
  /** 与 gateway 的 transport.billable、offlineMeter、Clock 一致；缺失时拒绝调用。 */
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
  const fromProvenance = req.provenance === undefined ? undefined : provenanceClass(req.provenance);
  const dataClass = req.dataClass === undefined ? fromProvenance : req.dataClass;
  if (
    dataClass === undefined ||
    !['synthetic', 'public_product', 'prompt', 'rewritten_sample', 'owner_aggregate'].includes(
      dataClass,
    ) ||
    (fromProvenance !== undefined && fromProvenance !== dataClass)
  ) {
    throw new VendorError('data_class_not_allowed', 'Missing or conflicting evaluation data class');
  }
  return dataClass;
}

export function createEvalModelPort(
  options: EvalModelPortOptions,
): (req: EvalModelRequest) => Promise<VendorResponse> {
  const config = { ...options };
  const metering = options.metering === undefined ? undefined : { ...options.metering };
  return async (req) => {
    if (req.vendor !== config.vendor || req.model !== config.model) {
      throw new ModelProtocolError('bad_request', 'Evaluation request does not match its port');
    }
    const dataClass = evaluationDataClass(req);
    if (
      metering === undefined ||
      typeof metering.billable !== 'boolean' ||
      (metering.billable &&
        (typeof metering.offlineMeter?.record !== 'function' ||
          typeof metering.clock?.now !== 'function'))
    ) {
      throw new ModelProtocolError('bad_request', 'Evaluation metering must be configured');
    }
    const request = toVendorRequest(req);
    try {
      return await config.gateway.invoke({
        ...request,
        vendor: config.vendor,
        model: config.model,
        purpose: 'offline',
        use: config.use,
        accessPath: config.accessPath,
        workspace: config.workspace,
        dataClass,
      });
    } catch (error) {
      // VendorGateway 只记录成功响应；这里只补记付费失败的已知用量。
      // 不包裹线上路由，也不组装响应，避免和路由补记或成功计量重叠。
      if (metering.billable && error instanceof ModelProtocolError && error.usage !== null) {
        metering.offlineMeter.record({
          vendor: config.vendor,
          model: config.model,
          purpose: 'offline',
          use: config.use,
          ...error.usage,
          recorded_at: metering.clock.now(),
        });
      }
      throw error;
    }
  };
}
