// Public surface of the risk module. Other modules import only from this file.
//
// Also compiled by the `test` project: this file and everything it exports use erasable syntax
// only, `import type` for type-only imports and relative imports with `.ts`; no parameter
// decorators or parameter properties (RiskModule carries a class decorator only, like
// PlatformModule). The ports are plain interfaces, so identity implements them without Nest types.
export { RiskModule } from './risk.module.ts';
export type { RiskModuleOptions } from './risk.module.ts';
export {
  DEVICE_SIGNING_KEYS,
  SIGNATURE_CHECK,
  SignatureError,
  createSignatureCheck,
} from './application/signature-check.ts';
export type {
  DeviceSigningKey,
  DeviceSigningKeys,
  SignatureDependencies,
  SignatureRequest,
} from './application/signature-check.ts';
