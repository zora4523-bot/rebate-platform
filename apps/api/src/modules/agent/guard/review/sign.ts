import type { Clock } from '../../../platform/index.ts';
import type { AliyunReviewDeps } from './index.ts';

/** ACS3 V3: clock and nonce are injected; returns headers only, never mutates the request.
 * https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
 * TODO(规划/11 §6): 真实调用验证 — blocked on staging 内容安全 Key。
 */
export function createAliyunAcs3Signer(deps: {
  readonly clock: Clock;
  readonly nonce: () => string;
}): AliyunReviewDeps['sign'] {
  void deps;
  throw new Error('NotImplemented: createAliyunAcs3Signer');
}
