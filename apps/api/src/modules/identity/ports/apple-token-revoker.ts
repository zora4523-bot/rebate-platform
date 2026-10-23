// Identity's port for revoking a Sign in with Apple authorization at account deletion (task
// B1-15g §9.2 #3 ②; 08 BR-ID-27 「Sign in with Apple 用户必须调用 Apple 撤销接口，失败重试 3 次后告警，
// 不阻塞注销完成」, BR-ID-04 细则: the resulting Apple notification is only logged).
// Called outside any transaction with the decrypted refresh token; resolving = revoked, rejecting =
// one failed attempt. Implementations never log the token.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
export interface AppleTokenRevokeInput {
  readonly appId: string;
  readonly refreshToken: string;
}

export interface AppleTokenRevoker {
  revoke(input: AppleTokenRevokeInput): Promise<void>;
}
