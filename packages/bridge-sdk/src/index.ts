// H5 bridge SDK (规划/03 §5.4). All method and event payloads come from generated contracts.
export { bridge as BridgeContract } from '@couli/contracts-ts';

/** Workspace package name. */
export const PACKAGE_NAME = '@couli/bridge-sdk';

export {
  BridgeError,
  Capability,
  call,
  has,
  isInApp,
  on,
  type BridgeErrorCode,
  type BridgeEvent,
  type BridgeEvents,
  type BridgeFailure,
  type BridgeMethodName,
  type BridgeMethods,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeTransport,
} from './bridge.ts';

export {
  createH5TokenManager,
  type H5ApiResponse,
  type H5Token,
  type H5TokenManager,
} from './token.ts';
