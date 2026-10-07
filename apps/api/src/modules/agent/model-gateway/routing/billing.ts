// 保留 B3-02c 的登记入口与配置一致性校验；成功和失败用量均由 VendorGateway 计量。
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

/** 同 createVendorGateway；另登记计费属性，供路由器与评测端口校验旧接线配置。 */
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
