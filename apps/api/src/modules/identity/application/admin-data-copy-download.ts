// Download of a wecom_session personal information copy on the console (task B1-27i; 规划/08 BR-ID-40
// 细则「企业微信会话交付的下载」; contract adminDownloadUserDataExport, CT-24q). Skeleton of the test
// stage: the rule tests in test/spec/identity/data-copies-download/** go through HTTP only, so these
// shapes are a starting point the implementation may change.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type {
  AuditPort,
  Clock,
  ExportStore,
  FieldCrypto,
  RootLogger,
} from '../../platform/index.ts';
import type { AdminDataCopyRegistrants, AdminDataCopyStatus } from './admin-data-copies.ts';

export interface AdminDataCopyDownloadInput {
  readonly appId: string;
  /** The calling admin: must be the request's registrant. */
  readonly adminId: string;
  readonly userId: string;
  readonly exportId: string;
  readonly regenerate: boolean;
  readonly ip: string | null;
}

export type AdminDataCopyDownloadResult =
  | {
      readonly kind: 'link';
      readonly url: string;
      readonly urlExpiresAt: Date;
      /** Only when this call generated it (first download or regenerate); never stored. */
      readonly password: string | null;
      readonly expiresAt: Date;
    }
  | { readonly kind: 'unknown_user' }
  | { readonly kind: 'unknown_export' }
  | { readonly kind: 'not_downloadable'; readonly status: AdminDataCopyStatus }
  | { readonly kind: 'permission_denied' };

export interface AdminDataCopyDownloadOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly store: ExportStore;
  readonly crypto: FieldCrypto;
  readonly registrants: AdminDataCopyRegistrants;
  readonly auditOn: (db: Kysely<DB>) => AuditPort;
}

export interface AdminDataCopyDownload {
  download(input: AdminDataCopyDownloadInput): Promise<AdminDataCopyDownloadResult>;
}

export function createAdminDataCopyDownload(
  options: AdminDataCopyDownloadOptions,
): AdminDataCopyDownload {
  void options;
  throw new Error('NotImplemented: createAdminDataCopyDownload');
}
