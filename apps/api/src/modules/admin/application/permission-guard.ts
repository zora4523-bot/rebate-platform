import type { Clock } from '../../platform/clock/index.ts';
import type { RedisNamespace } from '../../platform/redis/index.ts';
import type { AdminStepUpTier } from '../domain/permission-catalog.ts';

export interface AdminStepUpBinding {
  readonly appId: string;
  readonly adminId: string;
  readonly sessionId: string;
  readonly tier: AdminStepUpTier;
}

export interface AdminStepUpGrant {
  readonly step_up_token: string;
  readonly tier: AdminStepUpTier;
  readonly expire_at: string;
}

export interface AdminStepUpTokens {
  issue(binding: AdminStepUpBinding): Promise<AdminStepUpGrant>;
}

export interface AdminPermissionPrincipal {
  readonly appId: string;
  readonly adminId: string;
  readonly sessionId: string;
  readonly isSuper: boolean;
  readonly permissions: readonly string[];
  readonly hasVerifyPhone: boolean;
}

export interface AdminPermissionRequest {
  /** Trusted server-injected account/session/grants, never request body fields. */
  readonly principal: AdminPermissionPrincipal;
  readonly permission: string;
  readonly operation?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export interface AdminBusinessResponse {
  readonly statusCode: number;
  readonly body: { readonly code: number; readonly data?: unknown };
}

export interface AdminPermissionGuard {
  /** Reject with an HTTP error envelope; consume only after a 2xx/code=0 result. */
  run(
    request: AdminPermissionRequest,
    business: () => Promise<AdminBusinessResponse>,
  ): Promise<AdminBusinessResponse>;
}

/** Shared Redis namespace: admin-step-up, used by HTTP issuance and all guarded operations. */
export function createAdminStepUpTokens(deps: {
  readonly clock: Clock;
  readonly redis: RedisNamespace;
}): AdminStepUpTokens {
  void deps;
  throw new Error('NotImplemented: createAdminStepUpTokens');
}

export function createAdminPermissionGuard(deps: {
  readonly clock: Clock;
  readonly redis: RedisNamespace;
}): AdminPermissionGuard {
  void deps;
  throw new Error('NotImplemented: createAdminPermissionGuard');
}
