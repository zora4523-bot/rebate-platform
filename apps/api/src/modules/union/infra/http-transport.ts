import type { UnionTransport } from './replay.ts';

/** Uses the runtime fetch; cancellation/deadlines belong to the request's AbortSignal. */
export function createUnionHttpTransport(): UnionTransport {
  throw new Error('NotImplemented: createUnionHttpTransport');
}
