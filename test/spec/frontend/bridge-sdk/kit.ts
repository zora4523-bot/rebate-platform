import { vi } from 'vitest';
import { BridgeContract as contract } from '@couli/bridge-sdk';
import type {
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
  BridgeTransport,
  H5Token,
} from '@couli/bridge-sdk';
// Consume the generated metadata through the SDK's contract re-export.
export { contract };

// Test transport only: no native SDK, HTTP, browser navigation, clock or storage access.
export function installBridge(
  methods: readonly string[],
  respond: (request: BridgeRequest) => BridgeResponse | Promise<BridgeResponse> = (request) => ({
    id: request.id,
    code: 0,
    msg: '',
    data: {},
  }),
) {
  const listeners = new Set<(event: BridgeEvent) => void>();
  const postMessage = vi.fn(respond);
  const transport: BridgeTransport = {
    version: 1,
    methods,
    postMessage,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  vi.stubGlobal('__REBATE_BRIDGE__', transport);
  return {
    transport,
    postMessage,
    emit(event: BridgeEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

export function token(scope: H5Token['scope'], suffix: string): H5Token {
  return { token: `h5-test-${suffix}`, scope, expire_at: '2099-01-01T00:00:00Z' };
}

export function tokenBridge(...tokens: H5Token[]) {
  let index = 0;
  return installBridge(['auth.getH5Token'], (request) => {
    const data = tokens[index++];
    if (request.method !== 'auth.getH5Token' || data === undefined) {
      return { id: request.id, code: 90500, msg: 'unexpected request in fixture' };
    }
    return { id: request.id, code: 0, msg: '', data };
  });
}

/** Preserve synchronous throws as well as Promise rejections, so red sees NotImplemented. */
export function outcome<T>(operation: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(operation);
}
