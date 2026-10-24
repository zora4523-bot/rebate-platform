// Admin union account options (B1-22o; CT-24s adminListUnionAccountOptions, D10-243; BR-ATTR-02
// 细则「后台登记与启停」; 04 §6.6, §11.2). Skeleton only: the implementation round fills it in.
//
// - list: every union_accounts row of the app (or of one platform), not paged, ordered by
//   platform, account_name, then id; each row only union_account_id, platform and account_name,
//   whatever its status or authorization state. Never a credential; writes nothing (no audit).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export type AdminUnionAccountOption = Schema<'AdminUnionAccountOption'>;

export interface AdminUnionAccountOptionsDeps {
  /** Absent in isolated HTTP unit tests: every call fails closed. */
  readonly db: Kysely<DB> | undefined;
}

export interface AdminUnionAccountOptionsQuery {
  /** The signed-in admin's app (the guard's actor, never a request field). */
  readonly appId: string;
  /** Only this platform; undefined = every platform. */
  readonly platform: AdminUnionAccountOption['platform'] | undefined;
}

export class AdminUnionAccountOptions {
  constructor(deps: AdminUnionAccountOptionsDeps) {
    void deps;
    throw new Error('NotImplemented: AdminUnionAccountOptions');
  }

  list(query: AdminUnionAccountOptionsQuery): Promise<AdminUnionAccountOption[]> {
    void query;
    throw new Error('NotImplemented: AdminUnionAccountOptions.list');
  }
}
