import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock, createRootLogger, type ReceivedEvent } from '../../platform/index.ts';
import type { PushSendCore } from './push-send.ts';
import {
  createWithdrawalResultMessageConsumer,
  renderWithdrawalResultMessage,
  type WithdrawalResultFacts,
} from './withdrawal-result-message.ts';

function facts(patch: Partial<WithdrawalResultFacts>): WithdrawalResultFacts {
  return {
    status: 'FAILED',
    reject_reason_code: null,
    amount_fen: 1000n,
    net_fen: 920n,
    fail_code: null,
    payout_channel: 'wechat',
    ...patch,
  };
}

it('[AC-B1-12u#5] an account-type failure keeps the change-account hint after a body override', () => {
  const message = renderWithdrawalResultMessage(facts({ fail_code: 'PAYEE_NOT_EXIST' }), {
    title_override: null,
    body_override: '失败：{reason}',
  });
  expect(message?.body).toBe('失败：收款支付宝账号不存在，可修改收款账号后重试');
});

it('[AC-B1-12u#6] the WeChat failure items of withdraw_fail_reason are mapped, without the hint', () => {
  expect(
    renderWithdrawalResultMessage(facts({ fail_code: 'USER_CONFIRM_TIMEOUT' }), null)?.body,
  ).toBe('提现打款未成功：没有在规定时间内到微信确认收款，¥10 已退回余额');
});

it('[AC-B1-12u#3] a reject reason outside the dictionary reads as OTHER; prototype keys never resolve', () => {
  for (const code of ['UNKNOWN_CODE', 'toString', null]) {
    expect(
      renderWithdrawalResultMessage(facts({ status: 'REJECTED', reject_reason_code: code }), null)
        ?.body,
    ).toBe('提现未通过：其他原因，请联系客服，¥10 已退回余额');
  }
});

it('[AC-B1-12u#9] a `$` in an override is copied literally, not as a replacement pattern', () => {
  const message = renderWithdrawalResultMessage(facts({ status: 'PAID_API' }), {
    title_override: null,
    body_override: "$& $' {net}",
  });
  expect(message?.body).toBe("$& $' ¥9.2");
});

function consumer() {
  const push: PushSendCore = { record: vi.fn(), dispatch: vi.fn() };
  const logger = createRootLogger(
    { level: 'silent', entry: 'worker', appEnv: 'test' },
    {
      write() {},
    },
  );
  const sut = createWithdrawalResultMessageConsumer({
    clock: new FixedClock('2026-10-31T00:00:00.000Z'),
    logger,
    push,
  });
  return { sut, push };
}

function event(
  payload: Record<string, unknown>,
  name = 'wallet.withdrawal_changed',
): ReceivedEvent {
  return {
    eventId: '0192f000-0000-7000-8000-000000000001',
    appId: 'app-unit',
    name,
    version: 1,
    occurredAt: '2026-10-31T00:00:00.000Z',
    consumer: 'notification-withdrawal-result',
    attempt: 1,
    payload: payload as ReceivedEvent['payload'],
  };
}

/** A transaction handle that fails any use: the cases below must not read or write. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('the transaction must not be used');
    },
  },
) as Transaction<DB>;

it('[AC-B1-12u#14] a non-result status is acknowledged without touching the transaction or the push core', async () => {
  const { sut, push } = consumer();
  for (const status of ['PENDING_REVIEW', 'APPROVED', 'PAYING', 'paid_api']) {
    await expect(
      sut.handle(
        event({
          withdrawal_id: '0192f000-0000-7000-8000-0000000000aa',
          user_id: 'u-1',
          status,
        }),
        untouchable,
      ),
    ).resolves.toBeUndefined();
  }
  expect(push.record).not.toHaveBeenCalled();
});

it('[AC-B1-12u#26] a malformed payload or another event name fails the job', async () => {
  const { sut } = consumer();
  await expect(
    sut.handle(
      event({ withdrawal_id: 'not-a-uuid', user_id: 'u-1', status: 'PAID_API' }),
      untouchable,
    ),
  ).rejects.toThrow('invalid wallet.withdrawal_changed payload');
  await expect(
    sut.handle(event({ user_id: 'u-1', status: 'PAID_API' }), untouchable),
  ).rejects.toThrow('invalid wallet.withdrawal_changed payload');
  await expect(
    sut.handle(
      event(
        {
          withdrawal_id: '0192f000-0000-7000-8000-0000000000aa',
          user_id: 'u-1',
          status: 'PAID_API',
        },
        'withdrawal.created',
      ),
      untouchable,
    ),
  ).rejects.toThrow('unexpected event');
});
