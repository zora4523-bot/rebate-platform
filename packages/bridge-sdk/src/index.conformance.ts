// Untyped entry reserved for the conformance page (enforced by the existing H5 lint rule).

/** Export subpath of this entry; the only export until F1-01b lands. */
export const ENTRY_NAME = '@couli/bridge-sdk/conformance';

/** Same data / rejected BridgeFailure convention as call(); unknown or unsupported → 90001. */
export function invoke(method: string, params: unknown): Promise<unknown> {
  void method;
  void params;
  throw new Error('NotImplemented: invoke');
}
