// B2-15c unit tests of the notification entry's fixed answers and route filter (08 BR-PAY-04 细则
// 「通知应答」: no business information, one body per outcome; specs/pay-notify.md §1). No database,
// no Fastify: the controller is driven with a fake reply and a fake use case.
import { describe, expect, it } from 'vitest';
import { createRootLogger } from '../../../platform/index.ts';
import { NOTIFY_RAW_BODY } from './notify-body.ts';
import {
  ANSWERS,
  NOTIFY_ROUTES,
  PayNotifyController,
  isNotifyRoute,
  type PayNotifyDeps,
  type PayNotifyRawReply,
} from './pay-notify.controller.ts';

function reply(): PayNotifyRawReply & { sent: { status: number; type: string; body: string } } {
  const sent = { status: 0, type: '', body: '' };
  const raw: PayNotifyRawReply & { sent: typeof sent } = {
    sent,
    code(status) {
      sent.status = status;
      return raw;
    },
    type(contentType) {
      sent.type = contentType;
      return raw;
    },
    send(payload) {
      sent.body = payload;
    },
  };
  return raw;
}

function deps(rateLimited: boolean): PayNotifyDeps {
  const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
  return {
    // The use case is never reached in these tests: every channel adapter is missing.
    handler: {
      channels: {
        of: () => {
          throw new Error('no adapter');
        },
      },
    } as unknown as PayNotifyDeps['handler'],
    rateLimiter: { allow: () => Promise.resolve(!rateLimited) },
    logger,
  };
}

describe('[AC-B2-15c] notification entry answers', () => {
  it("[AC-B2-15c#15] every answer carries only the channel's fixed success / failure body", () => {
    expect(JSON.parse(ANSWERS.wechat_pay.ack.body)).toEqual({ code: 'SUCCESS', message: '成功' });
    expect(Object.keys(JSON.parse(ANSWERS.wechat_pay.nack.body)).sort()).toEqual([
      'code',
      'message',
    ]);
    expect(JSON.parse(ANSWERS.wechat_pay.nack.body).code).not.toBe('SUCCESS');
    expect(ANSWERS.wechat_pay.ack.status).toBe(200);
    expect(ANSWERS.wechat_pay.nack.status).toBeGreaterThanOrEqual(400);
    expect(ANSWERS.alipay.ack).toMatchObject({ status: 200, body: 'success' });
    expect(ANSWERS.alipay.nack.body).toBe('failure');
  });

  it('[AC-B2-15c#15] a refused request (rate limited) and a failing adapter both answer «not success» in the channel format', async () => {
    for (const rateLimited of [true, false]) {
      const controller = new PayNotifyController(deps(rateLimited));
      const request = {
        id: 'trace',
        ip: '198.18.0.1',
        headers: { 'content-type': 'application/json' },
        [NOTIFY_RAW_BODY]: Buffer.from('{}', 'utf8'),
      };
      const wechat = reply();
      await controller.wechat(request, wechat);
      expect(wechat.sent).toEqual({
        status: ANSWERS.wechat_pay.nack.status,
        type: ANSWERS.wechat_pay.nack.contentType,
        body: ANSWERS.wechat_pay.nack.body,
      });
      const alipay = reply();
      await controller.alipay(request, alipay);
      expect(alipay.sent.body).toBe('failure');
    }
  });

  it('[AC-B2-15c#17] the route filter selects exactly POST /notify/pay/wechat and /notify/pay/alipay', () => {
    expect(NOTIFY_ROUTES).toEqual({
      wechat_pay: '/notify/pay/wechat',
      alipay: '/notify/pay/alipay',
    });
    expect(isNotifyRoute('POST', '/notify/pay/wechat')).toBe(true);
    expect(isNotifyRoute('post', '/notify/pay/alipay')).toBe(true);
    expect(isNotifyRoute('GET', '/notify/pay/wechat')).toBe(false);
    expect(isNotifyRoute('POST', '/v1/pay/orders')).toBe(false);
    expect(isNotifyRoute('POST', '/notify/pay/other')).toBe(false);
  });
});
