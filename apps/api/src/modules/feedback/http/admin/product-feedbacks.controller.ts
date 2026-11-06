// B1-28s skeleton: GET /admin/v1/product-feedbacks (adminListProductFeedbacks, CT-26x, 编排
// D10-757), permission point feedback.view, read only, no step-up, no audit record. Only
// authorisation, the parameters and the call into application/admin-list.ts will live here.
// Rule tests: test/spec/feedback/admin-product-feedbacks/**. Not implemented yet (not mounted).
import type { Schema } from '@couli/contracts-ts';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AdminOperationGuard, CheckedRequest } from '../../../platform/index.ts';
import type { AdminProductFeedbackListQuery } from '../../application/admin-list.ts';

export interface AdminProductFeedbacksRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

export class AdminProductFeedbacksController {
  constructor(guard: AdminOperationGuard, db: Kysely<Database> | null) {
    void guard;
    void db;
    throw new Error('NotImplemented: AdminProductFeedbacksController');
  }

  list(
    request: AdminProductFeedbacksRequest,
    query: AdminProductFeedbackListQuery,
  ): Promise<Schema<'AdminProductFeedbackPageResponse'>> {
    void request;
    void query;
    throw new Error('NotImplemented: AdminProductFeedbacksController.list');
  }
}
