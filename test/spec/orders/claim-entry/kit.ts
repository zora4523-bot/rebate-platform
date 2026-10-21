import { expect } from 'vitest';
import type {
  ClaimEntryBinding,
  ClaimEntryLog,
} from '../../../../apps/api/src/modules/linking/index.ts';
import {
  claimEntryPinned,
  type ClaimEntryInput,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { capture } from '../list-detail/kit.ts';
export { capture } from '../list-detail/kit.ts';

// BR-ATTR-17 / AC-S1-25②; all instants are absolute milliseconds, not calendar days.
export const NOW = '2028-01-15T04:00:00.000Z';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const subject = {
  app_id: 'claim-entry-app',
  user_id: '0199a3b4-5c6d-7000-8000-000000000001',
};
export const otherUser = '0199a3b4-5c6d-7000-8000-000000000002';
export function ago(milliseconds: number): Date {
  const clock = new FixedClock(NOW);
  clock.advanceMs(-milliseconds);
  return clock.now();
}
export function log(patch: Partial<ClaimEntryLog> = {}): ClaimEntryLog {
  return {
    ...subject,
    id: 1n,
    opener_user_id: subject.user_id,
    platform: 'taobao',
    event: 'open',
    result_code: 0,
    pid_scene: 'self',
    no_rebate: false,
    no_rebate_reason: null,
    created_at: ago(HOUR),
    ...patch,
  };
}
export function binding(patch: Partial<ClaimEntryBinding> = {}): ClaimEntryBinding {
  return {
    ...subject,
    platform: 'taobao',
    status: 'active',
    bound_at: ago(HOUR - 1),
    relation_id: 'synthetic-relation',
    ...patch,
  };
}
export async function value<T>(action: () => T | Promise<T>): Promise<T> {
  const result = await capture(action);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  return result.value;
}
export async function pinned(patch: Partial<ClaimEntryInput> = {}): Promise<boolean> {
  return value(() =>
    claimEntryPinned({
      ...subject,
      now: ago(0),
      logs: [log()],
      bindings: [],
      latest_order_attr_at: null,
      ...patch,
    }),
  );
}
