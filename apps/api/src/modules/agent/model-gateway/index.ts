// ModelGateway 门面（05 B3-02）：其他模块只从这里导入。
// 再导出 vendors（B3-02a）、openai-compat（B3-02b）、degraded（B3-02d）、routing（B3-02c）的公开名，
// 外加评测 B 模式的在线模型端口 createEvalModelPort：以离线用途、可信评测来源经 VendorGateway 调用，
// 离线额度、外发许可等闸门由 VendorGateway 判定（BR-AI-14 细则「多厂商接入」）。
// 接线应以 createMeteredVendorGateway 创建网关：路由器与评测端口据其登记的 transport.billable、
// 计量去处与 Clock 推出失败用量的默认计量（只对计费传输补记，同一错误只记一次）。
// TODO(规划/11 §6): 真实评测运行 — blocked on 负责人提供 key 与供应商登记（06 Q-C21、Q-C31）
export * from './vendors/index.ts';
export * from './openai-compat/index.ts';
export * from './degraded/index.ts';
export * from './routing/index.ts';
export { createEvalModelPort } from './routing/eval-port.ts';
export type {
  EvalModelPortOptions,
  EvalModelRequest,
  EvalFailureMetering,
} from './routing/eval-port.ts';
