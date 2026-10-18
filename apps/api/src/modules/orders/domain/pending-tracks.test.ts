import { expect, it } from 'vitest';
import type { PendingAttempt } from '../../linking/index.ts';
import { FixedClock } from '../../platform/index.ts';
import { selectPendingTracks, type SelectPendingTracksInput } from './pending-tracks.ts';

const START = '2028-03-01T00:00:00.000Z';
function at(minutes: number, ms = 0): Date {
  const clock = new FixedClock(START);
  clock.advanceMs(minutes * 60_000 + ms);
  return clock.now();
}
const id = (n: number) => `019c0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
function attempt(n: number, patch: Partial<PendingAttempt> = {}): PendingAttempt {
  return {
    attempt_id: id(n),
    link_id: id(n + 500),
    platform: 'taobao',
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
function run(patch: Partial<SelectPendingTracksInput>) {
  return selectPendingTracks({
    now: at(20),
    toleranceSec: 120,
    attempts: [],
    orders: [],
    ...patch,
  });
}

it('[AC-B1-08m#1] 第一档里 open 最晚者胜出，即使第二档有更晚的 open', () => {
  const reported = attempt(2, { jump_reported_at: at(3) });
  const later = attempt(5);
  expect(run({ attempts: [later, reported] })).toEqual([
    {
      link_id: reported.link_id,
      attempt_id: reported.attempt_id,
      platform: 'taobao',
      jumped_at: at(2).toISOString(),
      show_claim_entry: false,
      dismissed: false,
    },
  ]);
});

it('[AC-B1-08m#4] 选中项被完成时该平台无卡，别的平台不受影响', () => {
  const tb = attempt(1);
  const jd = attempt(2, { platform: 'jd' });
  const items = run({
    attempts: [tb, jd],
    orders: [{ link_id: tb.link_id, attr_at: at(1, -120_000), source_match: 'shop' }],
  });
  expect(items.map((item) => item.attempt_id)).toEqual([jd.attempt_id]);
});

it('[AC-B1-08m#8] 未来时刻的 open 照常出卡但不出入口', () => {
  const ahead = attempt(30);
  expect(run({ attempts: [ahead] })).toMatchObject([
    { attempt_id: ahead.attempt_id, show_claim_entry: false },
  ]);
});

it('[AC-B1-08m#13] 无返利且原因不在名单时，即使已授权也不出入口', () => {
  const blocked = attempt(1, {
    no_rebate: true,
    no_rebate_reason: 'binding_blocked',
    authorized_after: true,
  });
  expect(run({ attempts: [blocked], now: at(40) })).toMatchObject([{ show_claim_entry: false }]);
});
