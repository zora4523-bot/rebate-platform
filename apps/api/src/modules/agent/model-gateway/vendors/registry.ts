import { VendorError } from './types.ts';
import type { OnlineVendorId, VendorRegistration } from './types.ts';

const REGISTRY: readonly VendorRegistration[] = Object.freeze([
  Object.freeze({
    vendor: 'qwen' as const,
    purposes: Object.freeze(['online', 'offline'] as const),
    accessPaths: Object.freeze(['bailian'] as const),
    capability: 'CAP-X-07' as const,
    offlineBudgetRequired: false,
  }),
  Object.freeze({
    vendor: 'glm' as const,
    purposes: Object.freeze(['offline'] as const),
    accessPaths: Object.freeze(['bailian', 'zhipu_open'] as const),
    capability: 'CAP-X-19' as const,
    offlineBudgetRequired: true,
  }),
]);

export function vendorRegistry(): readonly VendorRegistration[] {
  return REGISTRY;
}

export function registrationFor(vendor: string): VendorRegistration {
  const registration = REGISTRY.find((entry) => entry.vendor === vendor);
  if (!registration) throw new VendorError('vendor_unknown', 'Vendor is not registered');
  return registration;
}

export function assertOnlineVendor(vendor: string): OnlineVendorId {
  const registration = registrationFor(vendor);
  if (!registration.purposes.includes('online') || vendor !== 'qwen') {
    throw new VendorError('vendor_not_online', 'Vendor is not registered for online use');
  }
  return vendor;
}
