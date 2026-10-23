// The Apple revocation app.module assembles until the Apple keys and a recorded exchange exist
// (task B1-15g §9.2 #3 ②): every call rejects, so each attempt counts as a failure. Never an
// implementation that pretends to succeed.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { AppleTokenRevoker } from '../ports/apple-token-revoker.ts';

export function unconfiguredAppleTokenRevoker(): AppleTokenRevoker {
  throw new Error('NotImplemented: unconfiguredAppleTokenRevoker');
}
