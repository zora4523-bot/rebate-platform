// B1-28s skeleton: the read-only query behind GET /admin/v1/product-feedbacks
// (adminListProductFeedbacks, CT-26x, 编排 D10-757; 08 BR-ID-30 细则「商品反馈记录」). Rule tests:
// test/spec/feedback/admin-product-feedbacks/**. Not implemented yet.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** The query of the list as the route schema leaves it (all optional). */
export interface AdminProductFeedbackListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly platform?: string;
  readonly reason?: string;
  readonly from?: string;
  readonly to?: string;
}

export type AdminProductFeedbackPage = Schema<'AdminProductFeedbackPage'>;

/** One page of the app's product feedback records, newest first. */
export function listAdminProductFeedbacks(
  db: Kysely<DB>,
  appId: string,
  query: AdminProductFeedbackListQuery,
): Promise<AdminProductFeedbackPage> {
  void db;
  void appId;
  void query;
  throw new Error('NotImplemented: listAdminProductFeedbacks');
}
