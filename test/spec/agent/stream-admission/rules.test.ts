import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  RedisUnavailableError,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  AdmissionUnavailableError,
  admissionDefaults,
  createRedisAdmission,
  dayKeyOf,
  nextResetAt,
  nextStepOf,
  shouldRefund,
  type RunEnding,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';

it('[BR-AI-15] 默认值：会员 30 条/日，游客档 3 条/device_hash/日 + 30 条/IP/日，10 条/分，每会话 30 轮', () => {
  expect(admissionDefaults()).toEqual({
    memberDaily: 30,
    guestDaily: 3,
    guestIpDaily: 30,
    perMinute: 10,
    maxRounds: 30,
  });
});

it('[BR-AI-15] 自然日按 +08:00：日界两侧分属两天，reset_at 为次日 00:00+08:00', () => {
  const cases: [string, string, string][] = [
    ['2026-10-06T15:59:59.999Z', '2026-10-06', '2026-10-07T00:00:00+08:00'],
    ['2026-10-06T16:00:00.000Z', '2026-10-07', '2026-10-08T00:00:00+08:00'],
    ['2026-10-06T02:00:00.000Z', '2026-10-06', '2026-10-07T00:00:00+08:00'],
    ['2026-12-31T16:00:00.000Z', '2027-01-01', '2027-01-02T00:00:00+08:00'],
    ['2026-12-31T15:59:59.999Z', '2026-12-31', '2027-01-01T00:00:00+08:00'],
    ['2028-02-28T16:30:00.000Z', '2028-02-29', '2028-03-01T00:00:00+08:00'],
  ];
  for (const [instant, day, reset] of cases) {
    expect(dayKeyOf(new Date(instant)), instant).toBe(day);
    expect(nextResetAt(new Date(instant)), instant).toBe(reset);
  }
});

it('[BR-AI-15] 任意时刻：reset_at 在 (now, now+24h]，前一毫秒仍属当日，reset_at 起属次日', () => {
  const DAY = 86_400_000;
  const EIGHT_HOURS = 28_800_000;
  const localDay = (ms: number) => new Date(ms + EIGHT_HOURS).toISOString().slice(0, 10);
  const holds = (ms: number): boolean => {
    try {
      const reset = nextResetAt(new Date(ms));
      const resetMs = Date.parse(reset);
      return (
        /^\d{4}-\d{2}-\d{2}T00:00:00\+08:00$/.test(reset) &&
        resetMs > ms &&
        resetMs - ms <= DAY &&
        dayKeyOf(new Date(ms)) === localDay(ms) &&
        dayKeyOf(new Date(resetMs - 1)) === localDay(ms) &&
        dayKeyOf(new Date(resetMs)) !== localDay(ms)
      );
    } catch {
      return false;
    }
  };
  const details = fc.check(
    fc.property(
      fc.oneof(
        fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2040, 0, 1) }),
        fc
          .integer({ min: 18_000, max: 26_000 })
          .chain((d) => fc.constantFrom(d * DAY - EIGHT_HOURS - 1, d * DAY - EIGHT_HOURS)),
      ),
      holds,
    ),
    propParams(),
  );
  expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
});

it('[BR-AI-15] 30502 的 data.next：游客 login，已登录未绑手机 bind_phone，已绑手机 none', () => {
  expect(nextStepOf({ tier: 'guest', loggedIn: false, deviceHash: 'dh-1', ipKey: 'ik-1' })).toBe(
    'login',
  );
  expect(nextStepOf({ tier: 'guest', loggedIn: true, deviceHash: 'dh-1', ipKey: 'ik-1' })).toBe(
    'bind_phone',
  );
  expect(nextStepOf({ tier: 'member', userId: 'u-1' })).toBe('none');
});

it('[BR-AI-15] 退还：服务端原因结束且未下发卡片才退 1 条，其余结局照常计数', () => {
  const refundable: RunEnding[] = ['server_error', 'disabled', 'timeout', 'input_review_timeout'];
  const counted: RunEnding[] = [
    'stop',
    'fallback',
    'budget',
    'auth_required',
    'safety',
    'limit',
    'client_error',
    'cancelled',
    'disconnected',
    'consent_withdrawn',
  ];
  for (const ending of refundable) {
    expect(shouldRefund({ ending, cardsDelivered: 0 }), ending).toBe(true);
    expect(shouldRefund({ ending, cardsDelivered: 1 }), ending).toBe(false);
    expect(shouldRefund({ ending, cardsDelivered: 2 }), ending).toBe(false);
  }
  for (const ending of counted) {
    expect(shouldRefund({ ending, cardsDelivered: 0 }), ending).toBe(false);
    expect(shouldRefund({ ending, cardsDelivered: 1 }), ending).toBe(false);
  }
});

it('[BR-AI-23] Redis 不可用：admit 抛 AdmissionUnavailableError，不写任何键（调用方回 50401）', async () => {
  let sets = 0;
  const redis: RedisNamespace = {
    get: () => Promise.reject(new RedisUnavailableError('connect_failed', 'ECONNREFUSED')),
    set: () => {
      sets++;
      return Promise.reject(new RedisUnavailableError('connect_failed', 'ECONNREFUSED'));
    },
    eval: () => Promise.reject(new RedisUnavailableError('command_timeout')),
  };
  const admission = createRedisAdmission({
    redis,
    clock: new FixedClock('2026-10-06T10:00:00+08:00'),
    runMaxMs: 20_000,
    lockGraceMs: 30_000,
  });
  const limits = { memberDaily: 30, guestDaily: 3, guestIpDaily: 30, perMinute: 10, maxRounds: 30 };
  const request = {
    sessionId: 's-1',
    clientMsgId: 'm-1',
    runId: 'r-1',
    messageId: 'msg-1',
    subject: { tier: 'member', userId: 'u-1' } as const,
  };
  await expect(admission.admit(request, limits)).rejects.toBeInstanceOf(AdmissionUnavailableError);
  expect(sets).toBe(0);
});
