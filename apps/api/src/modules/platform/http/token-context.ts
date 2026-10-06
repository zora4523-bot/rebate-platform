import type { SessionScope } from '@couli/contracts-ts';

/** Verified stage ② context; never populate this from request headers or JWT identity levels. */
export interface TokenPrincipal {
  readonly uid: string;
  readonly app_id: string;
  readonly sid: string;
  readonly device_id: string;
  readonly scp: SessionScope;
}

/** Reads the principal attached by the existing preParsing request-check registration point. */
export function tokenPrincipal(request: object): TokenPrincipal | undefined {
  void request;
  throw new Error('NotImplemented: tokenPrincipal');
}
