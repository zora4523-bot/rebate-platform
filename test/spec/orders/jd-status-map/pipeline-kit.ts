import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  loadStatusMap,
  type StatusMap,
} from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { fixture } from '../attribution/kit.ts';
import { HEADER } from '../status-map/fixtures.ts';

// 接线用的合成表，只放接线要走到的码：jd.csv 的取值由 mapping.test.ts 钉，缺表不挡这里的断言。
const WIRING_CSV = `${HEADER}
14,PLATFORM_INVALID,synthetic,false,合成失效
16,PLATFORM_PAID,synthetic,false,合成付款
`;

interface LoggedWarn {
  readonly warn: { readonly mock: { readonly calls: readonly unknown[][] } };
}

export async function jdFixture(
  db: Kysely<DB>,
  patch: Omit<Partial<UnionOrder>, 'platform'> = {},
  map: StatusMap = loadStatusMap('jd', WIRING_CSV),
) {
  const f = await fixture(db, {
    platform: 'jd',
    raw_status: '16',
    attr_params: { relation_id: null, custom_parameters: null, sub_union_id: 'n_abcd1234' },
    ...patch,
  });
  return { ...f, deps: { ...f.deps, statusMaps: () => map } };
}

export function sourceMismatchCalls(logger: LoggedWarn): readonly unknown[][] {
  return logger.warn.mock.calls.filter(
    (call) => (call[0] as { event?: unknown }).event === 'order_source_mismatch',
  );
}

/** reason 等于给定值的 warn，只取字段。 */
export function warnFields(logger: LoggedWarn, reason: string): unknown[] {
  return logger.warn.mock.calls
    .filter((call) => (call[0] as { reason?: unknown }).reason === reason)
    .map((call) => call[0]);
}

/** 恰好一条，字段恰好四个：不带订单号、用户参数。 */
export function expectSourceMismatch(
  f: { readonly logger: LoggedWarn; readonly ctx: { readonly app_id: string } },
  rawStatus: string,
): void {
  expect(sourceMismatchCalls(f.logger).map((call) => call[0])).toEqual([
    {
      platform: 'jd',
      app_id: f.ctx.app_id,
      raw_status: rawStatus,
      event: 'order_source_mismatch',
    },
  ]);
}
