// Untyped entry reserved for the conformance page (enforced by the existing H5 lint rule).
import { invokeUntyped } from './bridge.ts';

/** Export subpath of this entry. */
export const ENTRY_NAME = '@couli/bridge-sdk/conformance';

/** Same data / rejected BridgeFailure convention as call(); unknown or unsupported → 90001. */
export function invoke(method: string, params: unknown): Promise<unknown> {
  return invokeUntyped(method, params);
}
