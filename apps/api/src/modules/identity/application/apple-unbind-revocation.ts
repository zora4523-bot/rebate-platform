// The Apple revocation after a console phone change unbound an Apple identity (规划/08 BR-WDR-01 细则
// 「清除标记只走人工」, BR-ID-28; contract adminEditUserProfile「Pending re-verification」, CT-26j; 编排
// D10-513 ④; task B1-02zw). Outside any transaction: the phone-change transaction deleted the binding
// and wrote one job carrying the refresh token only as the stored cipher; this handler decrypts it
// at call time (APPLE_REFRESH_TOKEN_CONTEXT) and calls the port. As the deletion flow counts them
// (deletion-processing.ts revokeApple): a failed attempt is retried, the third one is final with one
// warn line carrying app_id, and nothing here touches the phone change. Neither the token nor the
// error reaches a log line.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { FieldCrypto, JobHandler, RootLogger } from '../../platform/index.ts';
import type { AppleTokenRevoker } from '../ports/apple-token-revoker.ts';

export interface AppleUnbindRevocationOptions {
  readonly crypto: FieldCrypto;
  readonly apple: AppleTokenRevoker;
  readonly logger: Pick<RootLogger, 'warn'>;
}

export interface AppleUnbindRevocation {
  readonly handle: JobHandler;
}

export function createAppleUnbindRevocation(
  options: AppleUnbindRevocationOptions,
): AppleUnbindRevocation {
  void options;
  throw new Error('NotImplemented: createAppleUnbindRevocation');
}
