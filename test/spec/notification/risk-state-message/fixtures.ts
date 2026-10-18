// B1-12g / BR-TEXT-23: literal expected wording, independent of production templates.
import { randomUUID } from 'node:crypto';
import type { RiskStateMessagePayload } from '../../../../apps/api/src/modules/notification/application/risk-state-message.ts';
import type { ReceivedEvent } from '../../../../apps/api/src/modules/platform/index.ts';

export const CONSUMER = 'notification-risk-state';
export const QUEUE = 'evt.notification-risk-state';
export const NOW = '2026-10-18T04:05:06.789Z';

export const variants = [
  {
    variant: 'frozen',
    from: 'normal',
    to: 'frozen',
    frozen_until: null,
    body: '你的账户提现已暂停，原因：异常交易。如有疑问，可在帮助中心提交申诉。',
  },
  {
    variant: 'frozen_until',
    from: 'normal',
    to: 'frozen',
    frozen_until: '2026-11-29T16:00:00.000Z',
    body: '你的账户提现已暂停至 11-30 00:00，原因：异常交易。如有疑问，可在帮助中心提交申诉。',
  },
  {
    variant: 'unfrozen',
    from: 'frozen',
    to: 'normal',
    frozen_until: null,
    body: '你的账户提现已恢复。',
  },
  {
    variant: 'banned',
    from: 'normal',
    to: 'banned',
    frozen_until: null,
    body: '你的账号已被限制使用，原因：异常交易。可在说明页提交申诉。',
  },
  {
    variant: 'unbanned',
    from: 'banned',
    to: 'normal',
    frozen_until: null,
    body: '你的账号限制已解除，购物前需重新完成平台授权。',
  },
] as const;

export function payload(extra: Partial<RiskStateMessagePayload> = {}): RiskStateMessagePayload {
  return {
    app_id: 'couli',
    user_id: randomUUID(),
    from: 'normal',
    to: 'frozen',
    reason_category: 'abnormal_trade',
    frozen_until: null,
    ...extra,
  };
}

export function event(data: RiskStateMessagePayload, eventId = randomUUID()): ReceivedEvent {
  return {
    eventId,
    appId: data.app_id,
    name: 'risk.state_changed',
    version: 1,
    occurredAt: '2026-10-18T01:00:00.000Z',
    payload: data,
    consumer: CONSUMER,
    attempt: 1,
  };
}
