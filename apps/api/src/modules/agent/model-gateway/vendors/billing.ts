import type { VendorUsage } from './types.ts';

// 跨网关共享认领状态：最内层先认领（含非计费层），仅在该层实际计费时记账。
const claimed = new WeakSet<Error>();

/** 按结构识别协议失败用量，避免 vendors 反向依赖协议适配器。 */
export function claimFailureUsage(error: unknown): VendorUsage | null {
  if (!(error instanceof Error) || !('usage' in error) || claimed.has(error)) return null;
  const usage = error.usage;
  if (
    typeof usage !== 'object' ||
    usage === null ||
    !('input_tokens' in usage) ||
    !('output_tokens' in usage)
  ) {
    return null;
  }
  const { input_tokens, output_tokens } = usage;
  if (
    typeof input_tokens !== 'number' ||
    !Number.isSafeInteger(input_tokens) ||
    input_tokens < 0 ||
    typeof output_tokens !== 'number' ||
    !Number.isSafeInteger(output_tokens) ||
    output_tokens < 0
  ) {
    return null;
  }
  claimed.add(error);
  return { input_tokens, output_tokens };
}
