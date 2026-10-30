// B2-04la rule test without a database: the port's shape follows the orders declarations
// (ClaimReviewDeps['rebate'] in claim-review.ts, AdminAssignRebatePort in admin-assign.ts), so the
// one object can be wired into both use cases. The assignments below are checked by tsc; the run
// checks the factory returns both methods without touching its dependencies.
import { expect, it, vi } from 'vitest';
import type { ClaimReviewDeps } from '../../../../apps/api/src/modules/orders/application/claim-review.ts';
import type { AdminAssignRebatePort } from '../../../../apps/api/src/modules/orders/application/admin-assign.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createAttributionRebatePort,
  type AttributionRebateDependencies,
} from '../../../../apps/api/src/modules/settlement/index.ts';

it('[AC-B2-04la#14] 端口形状以 orders 声明为准：同一对象同时满足 ClaimReviewDeps.rebate 与 AdminAssignRebatePort，创建时不读配置、不打日志', () => {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        lines.push(line);
      },
    },
  );
  const get = vi.fn<AttributionRebateDependencies['config']['get']>(async () => undefined);
  const port = createAttributionRebatePort({ logger, config: { get } });

  const claim: ClaimReviewDeps['rebate'] = port;
  const assign: AdminAssignRebatePort = port;
  expect(typeof claim.onClaimApproved).toBe('function');
  expect(typeof assign.onAdminAssigned).toBe('function');
  expect(get).not.toHaveBeenCalled();
  expect(lines).toEqual([]);
});
