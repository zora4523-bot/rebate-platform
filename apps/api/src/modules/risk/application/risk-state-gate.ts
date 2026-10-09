// HTTP placement of stage ⑤ (规划/08 BR-ID-01 判定顺序: ⑤ after ④a, before ⑬; task B1-03h §9.2,
// §10), on the same two paths as stage ④a (./minimum-version.ts) and ⑬ (./rate-limit-gate.ts):
// - non-idempotent operations: the global guard, after ④a and before ⑬ (RiskModule chains the
//   stages in one guard); the state is read through the service's cache (sensitive operations
//   read the database);
// - idempotent operations: the idempotency post-miss hook, registered after ④a's and before ⑬'s,
//   so a replay, 40901 and the other idempotency refusals are not judged, and a 10006 writes no
//   idempotency record. The hook reads the HTTP request from MINIMUM_VERSION_SCOPE and every
//   state on the claim's transaction (idempotencyPostMissTransaction()): it never borrows a second
//   pooled connection while the claim holds one. Outside an HTTP request (no scope, e.g. a job or
//   a direct call of the idempotency service) there is nothing to judge.
import {
  idempotencyPostMissTransaction,
  type IdempotencyPostMissCheck,
} from '../../platform/index.ts';
import {
  MINIMUM_VERSION_SCOPE,
  contractRouteOf,
  type MinimumVersionRequest,
} from './minimum-version.ts';
import type { RiskStateRequest, RiskStateService } from './risk-state.ts';

export interface RiskStateGuardContext {
  switchToHttp(): { getRequest(): MinimumVersionRequest };
}

/** The guard part of stage ⑤: non-idempotent operations (idempotent ones: the hook). */
export function createRiskStateGuard(service: RiskStateService) {
  return {
    async canActivate(context: RiskStateGuardContext): Promise<boolean> {
      const request = context.switchToHttp().getRequest();
      if (contractRouteOf(request)?.idempotent === true) return true;
      await service.checkRequest(request as RiskStateRequest);
      return true;
    },
  };
}

/** The post-miss hook part of stage ⑤: judged on the idempotency claim's transaction. */
export function createRiskStatePostMissCheck(service: RiskStateService): IdempotencyPostMissCheck {
  return async () => {
    const scope = MINIMUM_VERSION_SCOPE.getStore();
    if (scope === undefined) return;
    await service.checkRequest(scope.request as RiskStateRequest, idempotencyPostMissTransaction());
  };
}
