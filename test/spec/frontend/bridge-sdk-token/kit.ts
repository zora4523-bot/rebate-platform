import { expect, vi } from 'vitest';
import type {
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
  BridgeTransport,
  H5Token,
} from '@couli/bridge-sdk';

// Adapted from bridge-sdk/kit.ts: only an in-memory native transport, no real platform calls.
export function installBridge(
  respond: (request: BridgeRequest) => BridgeResponse | Promise<BridgeResponse>,
) {
  const listeners = new Set<(event: BridgeEvent) => void>();
  const postMessage = vi.fn(respond);
  const transport: BridgeTransport = {
    version: 1,
    methods: ['auth.getH5Token'],
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
    postMessage,
    // Deliberately cross the native boundary with untrusted payloads, including unknown events.
    emit(event: string, data: unknown) {
      for (const listener of listeners) listener({ event, data } as BridgeEvent);
    },
  };
}

export function token(value: string): H5Token {
  return { token: value, scope: 'standard', expire_at: '2099-01-01T00:00:00Z' };
}

export function controlledBridge() {
  const pending: {
    request: BridgeRequest;
    resolve: (response: BridgeResponse) => void;
  }[] = [];
  const native = installBridge((request) => {
    const reply = Promise.withResolvers<BridgeResponse>();
    pending.push({ request, resolve: reply.resolve });
    return reply.promise;
  });
  return {
    ...native,
    reply(index: number, response: Omit<BridgeResponse, 'id'>) {
      const entry = pending[index];
      // A missing acquisition must produce an assertion failure, never a fixture TypeError.
      expect(entry, `native acquisition ${index + 1}`).toBeDefined();
      if (entry !== undefined) entry.resolve({ ...response, id: entry.request.id });
    },
  };
}

// Attach rejection handling immediately, even while a native reply is deliberately held.
export function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}
