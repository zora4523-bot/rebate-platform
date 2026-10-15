// The port through which every business module guards its admin operations (F1-06u; 02 §4.1
// 「各业务模块的后台接口在各自模块的 `http/admin/` 下，由本模块统一挂载守卫」; 04 §11; 08 BR-ID-34).
// Business modules must not import admin (admin depends on every module), so the port lives here,
// like the audit port: the abstract class is also the Nest injection token. The admin module
// implements it and provides it globally on the admin entry only; the api and stream entries do
// not provide it.
//
// Also compiled by the `test` project: erasable syntax only, no NestJS, no `process.env`.

/** Trusted identity handed to a business module after its admin operation is authorised. */
export interface AdminActor {
  readonly adminId: string;
  readonly appId: string;
  readonly isSuper: boolean;
  /** admin_users.login_name as read for this very request. */
  readonly loginName: string;
}

export interface AdminOperationInput {
  /** The Fastify request: its verified admin principal, X-Step-Up-Token header and id (trace_id). */
  readonly request: object;
  /** Permission key of specs/permissions.yaml. */
  readonly permission: string;
  /** Operation under the permission, when its step-up tier departs from the permission's. */
  readonly operation?: string;
}

export interface AdminOperationResponse {
  readonly statusCode: number;
  readonly body: { readonly code: number; readonly data?: unknown };
}

/**
 * Checks, in order: the verified admin principal (none → 50001, a programming error), the account
 * re-read (missing or not active → 10001), the permission point (10403), the step-up tier
 * (10003); then runs `business` and consumes the step-up token only after HTTP 2xx with code 0.
 * Rejections are thrown as error envelopes for the global error handling; a failing database or
 * Redis ends as 50001, never as an allowed operation.
 */
export abstract class AdminOperationGuard {
  abstract run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse>;
}
