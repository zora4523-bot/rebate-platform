// ModelGateway 门面（05 B3-02）：其他模块只从这里导入。
// 再导出 vendors（B3-02a）、openai-compat（B3-02b）、degraded（B3-02d）、routing（B3-02c）的公开名，
// 外加评测 B 模式的在线模型端口 createEvalModelPort：以离线用途、数据类别 synthetic 经 VendorGateway 调用，
// 离线额度、外发许可等闸门由 VendorGateway 判定（BR-AI-14 细则「多厂商接入」）。
// TODO(规划/11 §6): 真实评测运行 — blocked on 负责人提供 key 与供应商登记（06 Q-C21、Q-C31）
import type {
  AccessPath,
  OfflineUse,
  VendorGateway,
  VendorId,
  VendorResponse,
} from './vendors/index.ts';
import type { ModelRequestShape } from './openai-compat/index.ts';
import { ModelProtocolError, toVendorRequest } from './openai-compat/index.ts';

export * from './vendors/index.ts';
export * from './openai-compat/index.ts';
export * from './degraded/index.ts';
export * from './routing/index.ts';

export interface EvalModelPortOptions {
  readonly gateway: VendorGateway;
  readonly vendor: VendorId;
  readonly model: string;
  readonly use: OfflineUse;
  readonly accessPath: AccessPath;
  /** 业务空间标识。 */
  readonly workspace: string;
}

export function createEvalModelPort(
  options: EvalModelPortOptions,
): (req: ModelRequestShape) => Promise<VendorResponse> {
  const config = { ...options };
  return async (req) => {
    if (req.vendor !== config.vendor || req.model !== config.model) {
      throw new ModelProtocolError('bad_request', 'Evaluation request does not match its port');
    }
    const request = toVendorRequest(req);
    return config.gateway.invoke({
      ...request,
      vendor: config.vendor,
      model: config.model,
      purpose: 'offline',
      use: config.use,
      accessPath: config.accessPath,
      workspace: config.workspace,
      dataClass: 'synthetic',
    });
  };
}
