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
import { claimFailureUsage, gatewayBilling } from './billing.ts';

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
   * 失败用量补记，须与 gateway 的 transport.billable、offlineMeter、Clock 一致（与登记的 billable 矛盾则构造即拒绝）。
   * 省略时取 createMeteredVendorGateway 登记的值；付费评测的网关应以它创建，否则须显式注入。
   * 成功用量始终由 gateway 计量。
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

/**
 * 失败计量：显式注入优先，须与网关登记的 billable 一致；省略时取 createMeteredVendorGateway 登记的
 * offlineMeter、Clock 与 transport.billable（第 29 条）。两者都没有时返回 undefined（计费属性未知）。
 */
function resolveMetering(options: EvalModelPortOptions): EvalFailureMetering | undefined {
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
    return declared.billable
      ? { billable: true, offlineMeter: declared.offlineMeter, clock: declared.clock }
      : { billable: false };
  }
  if (registered === undefined) return undefined;
  return registered.billable
    ? { billable: true, offlineMeter: registered.offlineMeter, clock: registered.clock }
    : { billable: false };
}

export function createEvalModelPort(
  options: EvalModelPortOptions,
): (req: EvalModelRequest) => Promise<VendorResponse> {
  const config = { ...options };
  // 构造即校验，配置错误不等到第一次调用。
  const metering = resolveMetering(options);
  return async (req) => {
    if (req.vendor !== config.vendor || req.model !== config.model) {
      throw new ModelProtocolError('bad_request', 'Evaluation request does not match its port');
    }
    const dataClass = evaluationDataClass(req);
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
      // VendorGateway 只记录成功响应；这里只补记付费失败的已知用量，同一错误只记一次。
      // 无论记没记，带用量的错误都由本端口认领为离线调用：经 createPortTransport 传回路由器时不再记线上。
      if (
        error instanceof ModelProtocolError &&
        error.usage !== null &&
        claimFailureUsage(error) &&
        metering?.billable === true
      ) {
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
