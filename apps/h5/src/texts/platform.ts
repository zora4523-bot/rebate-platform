import type { Schema } from '@couli/contracts-ts';

export function getPlatformName(platform: keyof Schema<'ConfigPlatformIcons'>): string {
  void platform;
  throw new Error('NotImplemented: getPlatformName');
}
