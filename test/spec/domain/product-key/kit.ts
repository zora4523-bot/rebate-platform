import type { ProductKeyPlatform } from '@couli/domain';

// Synthetic inputs only: these are neither captured responses nor platform stability evidence.
export const platforms: readonly ProductKeyPlatform[] = Object.freeze([
  Object.freeze({ platform: 'taobao', keyPrefix: 'tb', parseEnabled: true, searchEnabled: true }),
  Object.freeze({ platform: 'jd', keyPrefix: 'jd', parseEnabled: true, searchEnabled: true }),
  Object.freeze({ platform: 'pdd', keyPrefix: 'pdd', parseEnabled: true, searchEnabled: true }),
  Object.freeze({ platform: 'eleme', keyPrefix: null, parseEnabled: true, searchEnabled: true }),
]);

export const taobao = Object.freeze({ platform: 'taobao', keyPrefix: 'tb' });
export const jdItem = Object.freeze({ platform: 'jd', keyPrefix: 'jd', jdMode: 'item' as const });
export const jdSku = Object.freeze({ platform: 'jd', keyPrefix: 'jd', jdMode: 'sku' as const });
export const pdd = Object.freeze({ platform: 'pdd', keyPrefix: 'pdd' });

// Capture only real Error instances; success and accidental non-Error throws cannot pass.
export function failureOf(run: () => unknown): Error | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
}
