// 规则测试（B1-12w；BR-ID-05；编排裁定 D10-315，台账评审 GT-23bgl S2）：验证码短信
// createVerifyCodeSmsSender —— identity SmsSender 端口的形状，接 notification 的短信主备框架。
// 模板与 BR-ID-05 一致：有效期取 identity 的 SMS_CODE_LIFETIME_SECONDS，模板变量恰为 {code}。
// 结果映射：sent → accepted；rejected → rejected；failed 且尝试全是 circuit_open → rejected
// （什么都没发出）；其余 failed → unknown；短信层自己抛错 → unknown。期望值一律手写。
import { expect, it } from 'vitest';
import * as verifyCode from '../../../../apps/api/src/modules/notification/sms/verify-code-sender.ts';
import { createVerifyCodeSmsSender } from '../../../../apps/api/src/modules/notification/sms/verify-code-sender.ts';
import type {
  SmsAttempt,
  SmsMessage,
  SmsSendResult,
} from '../../../../apps/api/src/modules/notification/resilience/index.ts';
import { SMS_CODE_LIFETIME_SECONDS } from '../../../../apps/api/src/modules/identity/domain/sms-limits.ts';

// 普通引号字符串（不是模板串）：${code} 是短信模板变量。
const EXPECTED_TEMPLATE_TEXT = '您的动态码为：${code}，5分钟内有效，请勿泄露！';

/** 模板里 ${...} 变量名的集合（排序）。 */
function variablesOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\$\{([^}]*)\}/gu)].map((match) => match[1] ?? ''))].sort();
}

const SENT: SmsSendResult = {
  outcome: 'sent',
  provider: 'aliyun',
  route: 'primary',
  selected: 'primary',
  degraded: false,
  providerMessageId: 'biz-synthetic-1',
  attempts: [{ provider: 'aliyun', route: 'primary', result: 'ok' }],
};

function attempt(result: SmsAttempt['result'], route: SmsAttempt['route'] = 'primary'): SmsAttempt {
  return { provider: route === 'primary' ? 'aliyun' : 'fake-backup', route, result };
}

function failed(...attempts: SmsAttempt[]): SmsSendResult {
  return {
    outcome: 'failed',
    reason: attempts.length > 1 ? 'all_channels_down' : 'no_backup',
    selected: 'primary',
    attempts,
  };
}

const request = {
  app_id: 'couli',
  phone: '13912345678',
  purpose: 'login' as const,
  code: '042019',
};

it('[AC-B1-12w#10][BR-ID-05] 验证码模板：编码 SMS_CODE，文案逐字一致；「N分钟」的 N × 60 等于 SMS_CODE_LIFETIME_SECONDS，模板变量恰为 {code}', () => {
  const exported = verifyCode as unknown as Readonly<Record<string, unknown>>;
  expect(exported['VERIFY_CODE_TEMPLATE']).toBe('SMS_CODE');
  expect(exported['VERIFY_CODE_TEMPLATE_TEXT']).toBe(EXPECTED_TEMPLATE_TEXT);
  const text = String(exported['VERIFY_CODE_TEMPLATE_TEXT']);
  const minutes = /(\d+)分钟/u.exec(text);
  expect(Number(minutes?.[1]) * 60).toBe(SMS_CODE_LIFETIME_SECONDS);
  expect(variablesOf(text)).toEqual(['code']);
});

it('[AC-B1-12w#11][BR-ID-05] 三种用途共用 SMS_CODE 模板：交给短信层的消息逐字段确定，params 只有 code（键集合与模板变量相同），每条一个新 message_id', async () => {
  const seen: SmsMessage[] = [];
  let ids = 0;
  const sender = createVerifyCodeSmsSender({
    sms: {
      send: async (message) => {
        seen.push(message);
        return SENT;
      },
    },
    messageId: () => `vc-msg-${String(++ids)}`,
  });
  const results: unknown[] = [];
  results.push(await sender.send({ ...request, purpose: 'login' }));
  results.push(
    await sender.send({ app_id: 'couli-b', phone: '13800000000', purpose: 'bind', code: '000123' }),
  );
  results.push(await sender.send({ ...request, purpose: 'step_up', code: '999999' }));
  expect(results).toEqual(['accepted', 'accepted', 'accepted']);
  expect(seen).toEqual([
    {
      app_id: 'couli',
      message_id: 'vc-msg-1',
      phone: '13912345678',
      template: 'SMS_CODE',
      params: { code: '042019' },
    },
    {
      app_id: 'couli-b',
      message_id: 'vc-msg-2',
      phone: '13800000000',
      template: 'SMS_CODE',
      params: { code: '000123' },
    },
    {
      app_id: 'couli',
      message_id: 'vc-msg-3',
      phone: '13912345678',
      template: 'SMS_CODE',
      params: { code: '999999' },
    },
  ]);
  for (const message of seen) {
    expect(Object.keys(message.params).sort()).toEqual(variablesOf(EXPECTED_TEMPLATE_TEXT));
  }
});

it.each([
  ['sent', 'accepted', SENT],
  [
    'rejected',
    'rejected',
    {
      outcome: 'rejected',
      provider: 'aliyun',
      route: 'primary',
      selected: 'primary',
      degraded: false,
      attempts: [attempt('rejected')],
    },
  ],
  ['failed：circuit_open', 'rejected', failed(attempt('circuit_open'))],
  [
    'failed：circuit_open, circuit_open',
    'rejected',
    failed(attempt('circuit_open'), attempt('circuit_open', 'backup')),
  ],
  ['failed：timeout', 'unknown', failed(attempt('timeout'))],
  ['failed：channel_error', 'unknown', failed(attempt('channel_error'))],
  [
    'failed：circuit_open, timeout',
    'unknown',
    failed(attempt('circuit_open'), attempt('timeout', 'backup')),
  ],
  [
    'failed：channel_error, circuit_open',
    'unknown',
    failed(attempt('channel_error'), attempt('circuit_open', 'backup')),
  ],
] as [string, string, SmsSendResult][])(
  '[AC-B1-12w#12][BR-ID-05] 短信层结果映射到 identity 的三态：%s → %s',
  async (_name, expected, result) => {
    let calls = 0;
    const sender = createVerifyCodeSmsSender({
      sms: {
        send: async () => {
          calls += 1;
          return result;
        },
      },
      messageId: () => 'vc-msg-1',
    });
    expect({ delivery: await sender.send(request), calls }).toEqual({
      delivery: expected,
      calls: 1,
    });
  },
);

it('[AC-B1-12w#13][BR-ID-05] 短信层自己抛错（返回被拒绝的 promise，或同步抛出）→ unknown，不向上抛', async () => {
  const rejecting = createVerifyCodeSmsSender({
    sms: { send: () => Promise.reject(new Error('synthetic sms layer failure')) },
    messageId: () => 'vc-msg-1',
  });
  const throwing = createVerifyCodeSmsSender({
    sms: {
      send: () => {
        throw new Error('synthetic sms layer failure (sync)');
      },
    },
    messageId: () => 'vc-msg-2',
  });
  const outcomes: unknown[] = [];
  for (const sender of [rejecting, throwing]) {
    outcomes.push(
      await sender.send(request).then(
        (delivery) => delivery,
        () => 'threw',
      ),
    );
  }
  expect(outcomes).toEqual(['unknown', 'unknown']);
});
