import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { IdempotencyPostMissCheck, RootLogger } from '../../platform/index.ts';
import type { MinimumVersionRequest } from '../../risk/index.ts';

export interface PrivacyConsentInput {
  readonly minVersion: unknown;
  readonly current: { readonly accepted: boolean; readonly version: number } | null;
}

export interface PrivacyConsentConfigReader {
  configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: unknown; readonly version: number } | null>;
}

export interface PrivacyConsentOptions {
  readonly db: Kysely<DB> | null;
  readonly config: {
    readonly pooled: PrivacyConsentConfigReader;
    readonly on: (handle: Kysely<DB>) => PrivacyConsentConfigReader;
  } | null;
  readonly logger: Pick<RootLogger, 'warn'>;
}

export interface PrivacyConsentChecks {
  readonly guard: {
    canActivate(context: {
      switchToHttp(): { getRequest(): MinimumVersionRequest };
    }): Promise<boolean>;
  };
  readonly postMiss: IdempotencyPostMissCheck;
}

// Class token avoids an executable constant initializer in the test-phase skeleton.
export class PRIVACY_CONSENT_CHECKS {}

export function privacyConsentRefusal(input: PrivacyConsentInput): null | 10004 {
  void input;
  throw new Error('NotImplemented: privacyConsentRefusal');
}

export function createPrivacyConsentChecks(options: PrivacyConsentOptions): PrivacyConsentChecks {
  void options;
  throw new Error('NotImplemented: createPrivacyConsentChecks');
}
