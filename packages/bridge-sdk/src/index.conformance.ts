// Untyped entry reserved for the conformance page (enforced by the existing H5 lint rule).
import { invokeUntyped, onUntyped } from './bridge.ts';

/** Export subpath of this entry. */
export const ENTRY_NAME = '@couli/bridge-sdk/conformance';

/** Same data / rejected BridgeFailure convention as call(); unknown or unsupported → 90001. */
export function invoke(method: string, params: unknown): Promise<unknown> {
  return invokeUntyped(method, params);
}

/**
 * Subscribes to a native event without the contract allowlist of on(): data arrives as native
 * sent it (missing data as {}), so the conformance page can show contract violations.
 */
export function onRaw(event: string, handler: (data: unknown) => void): () => void {
  return onUntyped(event, handler);
}
