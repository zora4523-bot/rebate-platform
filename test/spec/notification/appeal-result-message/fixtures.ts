import { randomUUID } from 'node:crypto';
import type { AppealResultMessagePayload } from '../../../../apps/api/src/modules/notification/application/appeal-result-message.ts';
import type { ReceivedEvent } from '../../../../apps/api/src/modules/platform/index.ts';

export const CONSUMER = 'notification-appeal-result';
export const QUEUE = 'evt.notification-appeal-result';
export const NOW = '2026-10-22T04:05:06.789Z';

// Expected wording is literal BR-TEXT-23 text, never imported from production templates.
export const variants = [
  {
    variant: 'account_revoked',
    target_type: 'account',
    status: 'revoked',
    body: '你的申诉已通过，相关限制已解除。',
  },
  {
    variant: 'order_revoked',
    target_type: 'order',
    status: 'revoked',
    body: '你对一笔订单的申诉已通过，返利将在复核后恢复。',
  },
  {
    variant: 'upheld',
    target_type: 'account',
    status: 'upheld',
    body: '你的申诉已处理，维持原处理结果。如有疑问请联系客服。',
  },
  {
    variant: 'upheld',
    target_type: 'order',
    status: 'upheld',
    body: '你的申诉已处理，维持原处理结果。如有疑问请联系客服。',
  },
] as const;

export function payload(
  extra: Partial<AppealResultMessagePayload> = {},
): AppealResultMessagePayload {
  const userId = randomUUID();
  return {
    app_id: 'couli',
    appeal_id: randomUUID(),
    user_id: userId,
    target_type: 'account',
    target_id: userId,
    status: 'revoked',
    need_reauth: false,
    ...extra,
  };
}

export function event(data: AppealResultMessagePayload, eventId = randomUUID()): ReceivedEvent {
  return {
    eventId,
    appId: data.app_id,
    name: 'appeal.resolved',
    version: 1,
    occurredAt: '2026-10-21T01:00:00.000Z',
    payload: data,
    consumer: CONSUMER,
    attempt: 1,
  };
}
