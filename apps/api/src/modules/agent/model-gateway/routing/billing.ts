// 失败用量的计费归属（B3-02c，编排裁定第 29 条）：VendorGateway 只为成功响应计量，
// 带 usage 的 ModelProtocolError 由路由器（线上）或评测端口（离线）在各自边界补记。
// 本文件让两处补记能拿到可信的计费属性，并保证同一个错误对象只被补记一次：
// - createMeteredVendorGateway 与 createVendorGateway 等价，另登记 transport.billable、两个计量去处与 Clock，
//   路由器与评测端口据此推出默认的失败计量，不必由接线方各传一遍；
// - 评测端口认领经过它的带用量协议错误（已记离线或无法记），路由器见到已认领的错误不再记线上计量。
import type { Clock } from '../../../platform/index.ts';
import { createVendorGateway } from '../vendors/index.ts';
import type { UsageSink, VendorGateway, VendorGatewayOptions } from '../vendors/index.ts';
import { ModelProtocolError } from '../openai-compat/index.ts';

export interface GatewayBilling {
  /** 与 transport.billable 相同；false 表示不产生费用（回放、评测端口适配器）。 */
  readonly billable: boolean;
  readonly onlineMeter: UsageSink;
  readonly offlineMeter: UsageSink;
  readonly clock: Clock;
}

const registry = new WeakMap<VendorGateway, GatewayBilling>();
const claimed = new WeakSet<ModelProtocolError>();

/** 同 createVendorGateway；另登记计费属性，供 createModelRouter / createEvalModelPort 推出默认失败计量。 */
export function createMeteredVendorGateway(options: VendorGatewayOptions): VendorGateway {
  const billable: unknown = options.transport.billable;
  if (typeof billable !== 'boolean') {
    throw new ModelProtocolError('bad_request', 'Transport must declare whether it is billable');
  }
  const gateway = createVendorGateway(options);
  registry.set(
    gateway,
    Object.freeze({
      billable,
      onlineMeter: options.onlineMeter,
      offlineMeter: options.offlineMeter,
      clock: options.clock,
    }),
  );
  return gateway;
}

/** 未经 createMeteredVendorGateway 创建（例如被包装过）的网关返回 undefined。 */
export function gatewayBilling(gateway: VendorGateway): GatewayBilling | undefined {
  return registry.get(gateway);
}

/** 认领一个失败用量：返回 true 表示调用方是第一个认领者，可以补记。 */
export function claimFailureUsage(error: ModelProtocolError): boolean {
  if (claimed.has(error)) return false;
  claimed.add(error);
  return true;
}
