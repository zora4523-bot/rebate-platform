// Admin union account options (B1-22o; CT-24s adminListUnionAccountOptions, D10-243; BR-ATTR-02
// 细则「后台登记与启停」; 04 §6.6, §11.2).
//
// - list: every union_accounts row of the app (or of one platform), not paged, ordered by
//   platform, account_name, then id (the same order as GET /admin/v1/union-accounts); each row
//   only union_account_id, platform and account_name, whatever its status or authorization state.
//   Never a credential; writes nothing (no audit).
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
  readonly #db: Kysely<DB> | undefined;

  constructor(deps: AdminUnionAccountOptionsDeps) {
    this.#db = deps.db;
  }

  async list(query: AdminUnionAccountOptionsQuery): Promise<AdminUnionAccountOption[]> {
    if (this.#db === undefined) throw new Error('union: account options need the database');
    let select = this.#db
      .withSchema('app')
      .selectFrom('union_accounts')
      .select(['id', 'platform', 'account_name'])
      .where('app_id', '=', query.appId);
    if (query.platform !== undefined) select = select.where('platform', '=', query.platform);
    const rows = await select.orderBy('platform').orderBy('account_name').orderBy('id').execute();
    return rows.map((row) => ({
      union_account_id: row.id,
      platform: row.platform as AdminUnionAccountOption['platform'],
      account_name: row.account_name,
    }));
  }
}
