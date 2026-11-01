// B2-15k: the channel set of a process (task §9.1, §9.9; NotImplemented skeleton). payment.module
// replaces payChannelSetFor with createPayChannelSet: fake channels where the configuration says
// so, a real adapter per channel with complete credentials, UnavailablePayChannel otherwise; it
// never throws for a missing credential and never falls back to a fake channel.
// Also compiled by the `test` project: erasable syntax only.
import type { PayChannelSet } from '../../application/pay-channel.ts';
import type { AppConfig, Clock, RootLogger } from '../../../platform/index.ts';
import type { PayTransport } from './transport.ts';

export { AlipayPayChannel } from './alipay/alipay-pay-channel.ts';
export { WechatPayChannel } from './wechat/wechat-pay-channel.ts';
export { UnavailablePayChannel } from './unavailable-pay-channel.ts';
export { fetchPayTransport } from './transport.ts';
export type { PayHttpRequest, PayHttpResponse, PayTransport } from './transport.ts';

export interface PayChannelSetDeps {
  /** Defaults to fetchPayTransport. */
  readonly transport?: PayTransport;
  readonly clock: Clock;
  readonly logger: RootLogger;
}

export function createPayChannelSet(
  config: AppConfig,
  deps: PayChannelSetDeps,
): Promise<PayChannelSet> {
  void config;
  void deps;
  throw new Error('NotImplemented: createPayChannelSet');
}
