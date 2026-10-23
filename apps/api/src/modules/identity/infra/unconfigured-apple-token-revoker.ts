// The Apple revocation app.module assembles until the Apple keys and a recorded exchange exist
// (task B1-15g §9.2 #3 ②): every call rejects, so each attempt counts as a failure. Never an
// implementation that pretends to succeed.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { AppleTokenRevoker } from '../ports/apple-token-revoker.ts';

// TODO(规划/11 §2.3): 真实 Apple 撤销适配器（/auth/revoke） — blocked on Apple 密钥与真实录制
export function unconfiguredAppleTokenRevoker(): AppleTokenRevoker {
  return {
    revoke(): Promise<void> {
      // The token is never put into the error.
      return Promise.reject(new Error('identity: Apple token revocation is not configured'));
    },
  };
}
