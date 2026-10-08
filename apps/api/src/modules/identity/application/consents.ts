import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, TokenPrincipal } from '../../platform/index.ts';

export interface ConsentCommand {
  readonly app_id: string;
  readonly device_id?: string;
  readonly principal?: TokenPrincipal;
  readonly body: Schema<'RecordConsentRequest'>;
}

export interface ConsentService {
  record(
    command: ConsentCommand,
  ): Promise<
    | { readonly code: 0; readonly data: Schema<'EmptyResponse'>['data'] }
    | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  >;
}

export interface ConsentOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

export function createConsentService(options: ConsentOptions): ConsentService {
  void options;
  throw new Error('NotImplemented: createConsentService');
}
