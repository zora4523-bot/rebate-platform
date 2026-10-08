import type { Schema } from '@couli/contracts-ts';
import type { Clock, TokenPrincipal } from '../../platform/index.ts';
import type { SessionLookup, TokenKeyProvider } from './access-tokens.ts';
import type { SmsConfigReader } from './sms-codes.ts';

export interface H5TokenService {
  issue(command: {
    readonly principal: TokenPrincipal;
    readonly body: Schema<'IssueH5TokenRequest'>;
  }): Promise<
    { readonly code: 0; readonly data: Schema<'H5TokenData'> } | { readonly code: 10002 | 50001 }
  >;
}

export interface H5TokenOptions {
  readonly clock: Clock;
  readonly keys: TokenKeyProvider;
  readonly sessions: SessionLookup;
  readonly config: SmsConfigReader;
}

export function createH5TokenService(options: H5TokenOptions): H5TokenService {
  void options;
  throw new Error('NotImplemented: createH5TokenService');
}
