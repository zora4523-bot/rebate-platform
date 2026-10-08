import type { SearchCursorCodec } from '../search.ts';

/** Shared deployment key: independent staging / prod instances receive the same bytes. */
export function createSignedSearchCursorCodec(signingKey: Uint8Array): SearchCursorCodec {
  void signingKey;
  throw new Error('NotImplemented: createSignedSearchCursorCodec');
}
