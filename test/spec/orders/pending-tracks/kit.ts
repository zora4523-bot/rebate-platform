import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { PendingAttempt } from '../../../../apps/api/src/modules/linking/index.ts';
import * as orders from '../../../../apps/api/src/modules/orders/index.ts';

export const START = '2028-01-15T00:00:00.000Z';
export function at(minutes: number, ms = 0): Date {
  const clock = new FixedClock(START);
  clock.advanceMs(minutes * 60_000 + ms);
  return clock.now();
}
export function uuid(n: number): string {
  return `019b0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}
export function attempt(n: number, patch: Partial<PendingAttempt> = {}): PendingAttempt {
  return {
    attempt_id: uuid(n),
    link_id: uuid(n + 100),
    platform: 'jd',
    pid_scene: 'self_buy',
    opened_at: at(n),
    jump_reported_at: null,
    dismissed_at: null,
    no_rebate: false,
    no_rebate_reason: null,
    authorized_after: false,
    ...patch,
  };
}
export function card(a: PendingAttempt, claim = false, dismissed = false) {
  return {
    link_id: a.link_id,
    attempt_id: a.attempt_id,
    platform: a.platform,
    jumped_at: a.opened_at.toISOString(),
    show_claim_entry: claim,
    dismissed,
  };
}
export async function capture<T>(action: () => T | Promise<T>) {
  try {
    return { ok: true as const, value: await action() };
  } catch (error) {
    return { ok: false as const, error };
  }
}
export async function select(
  attempts: readonly PendingAttempt[],
  patch: Partial<orders.SelectPendingTracksInput> = {},
) {
  const result = await capture(() =>
    orders.selectPendingTracks({
      now: at(20),
      toleranceSec: 120,
      attempts,
      orders: [],
      ...patch,
    }),
  );
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  return result.value;
}
