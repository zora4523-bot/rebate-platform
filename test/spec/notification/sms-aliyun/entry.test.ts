// 规则测试（B1-12w；编排裁定 D10-315）：装配入口 createEntrySmsSender（经 notification 公共出口）。
// 有配置：resilience createSmsSender（主通道 = 阿里云 SendSms，不登记备用，开关恒 null）外套验证码
// 发送；签名名称与模板 CODE 来自配置。无配置：原样返回 fallback() 的发送器（app.module 传 identity 的
// createSmsSender，保持拒发 + warn）。时限取自 platform 登记表 sms 行，通道写不重发。
import { expect, it, vi } from 'vitest';
import {
  createEntrySmsSender,
  type VerifyCodeSmsSender,
} from '../../../../apps/api/src/modules/notification/index.ts';
import {
  FixedClock,
  createResilienceRegistry,
  type SmsConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  AT,
  DEFAULT_ENDPOINT,
  ManualScheduler,
  OK_REPLY,
  fullText,
  json,
  lowerHeaders,
  observe,
  recomputedAuthorization,
  requestView,
  transport,
  type Reply,
} from './kit.ts';

const CONFIG: SmsConfig = Object.freeze({
  accessKeyId: 'test-sms-id',
  accessKeySecret: 'test-sms-sentinel-value',
  signName: '测试签名',
  verifyCodeTemplate: 'SMS_000000001',
});

const REQUEST = {
  app_id: 'couli',
  phone: '13912345678',
  purpose: 'login' as const,
  code: '042019',
};

function entry(replies: readonly Reply[], sms: SmsConfig | undefined) {
  const scheduler = new ManualScheduler();
  const registry = createResilienceRegistry();
  const wire = transport(replies);
  const fallbackSender: VerifyCodeSmsSender = {
    send: vi.fn(async () => 'rejected' as const),
  };
  const fallback = vi.fn(() => fallbackSender);
  let ids = 0;
  let nonces = 0;
  const sender = createEntrySmsSender({
    sms,
    fallback,
    registry,
    scheduler,
    fetch: wire.fetch,
    clock: new FixedClock(AT),
    nonce: () => `sms-nonce-${String(++nonces)}`,
    messageId: () => `vc-msg-${String(++ids)}`,
  });
  return { ...wire, scheduler, registry, fallback, fallbackSender, sender };
}

it('[AC-B1-12w#17] 有配置：一次验证码发送只发一次 SendSms 请求，SignName / TemplateCode 来自配置，签名用配置的凭据（可复算）；受理 → accepted，不调 fallback', async () => {
  const rig = entry([OK_REPLY, OK_REPLY], CONFIG);
  const outcome = observe(rig.sender.send(REQUEST));
  await rig.scheduler.advance(0);
  expect({ settled: outcome.settled, value: outcome.value, calls: rig.calls.length }).toEqual({
    settled: 'resolved',
    value: 'accepted',
    calls: 1,
  });
  const sent = rig.calls[0];
  expect(sent).toBeDefined();
  if (sent === undefined) return;
  const view = requestView(sent);
  expect({ method: view.method, base: view.base, body: view.body, query: view.query }).toEqual({
    method: 'POST',
    base: DEFAULT_ENDPOINT,
    body: '',
    query: {
      params: {
        PhoneNumbers: '13912345678',
        SignName: '测试签名',
        TemplateCode: 'SMS_000000001',
        TemplateParam: '{"code":"042019"}',
        OutId: 'vc-msg-1',
      },
      count: 5,
    },
  });
  expect(lowerHeaders(sent.init.headers)['authorization']).toBe(
    recomputedAuthorization(sent, {
      accessKeyId: CONFIG.accessKeyId,
      accessKeySecret: CONFIG.accessKeySecret,
    }),
  );
  expect(rig.fallback).not.toHaveBeenCalled();
  expect(rig.unexpectedFetch).not.toHaveBeenCalled();
  expect(fullText(rig.calls)).not.toContain(CONFIG.accessKeySecret);
});

it('[AC-B1-12w#18] 无配置：原样返回 fallback() 的发送器，发送交给它，不发任何请求', async () => {
  const rig = entry([OK_REPLY], undefined);
  expect(rig.sender).toBe(rig.fallbackSender);
  expect(rig.fallback).toHaveBeenCalledTimes(1);
  const delivery = await rig.sender.send(REQUEST);
  expect(delivery).toBe('rejected');
  expect(rig.fallbackSender.send).toHaveBeenCalledWith(REQUEST);
  expect({ calls: rig.calls.length, global: rig.unexpectedFetch.mock.calls.length }).toEqual({
    calls: 0,
    global: 0,
  });
});

it('[AC-B1-12w#19] 通道超时：按登记表 sms 行的时限（≥ 1000 毫秒）中止请求，结果 unknown，不重发', async () => {
  const rig = entry(['hang', OK_REPLY], CONFIG);
  const timeoutMs = rig.registry.entry('sms').policy.timeoutMs;
  expect(timeoutMs).toBeGreaterThanOrEqual(1000);
  const outcome = observe(rig.sender.send(REQUEST));
  await rig.scheduler.advance(timeoutMs - 1);
  const before = {
    settled: outcome.settled,
    calls: rig.calls.length,
    aborted: rig.calls[0]?.init.signal.aborted,
  };
  await rig.scheduler.advance(1);
  const atDeadline = { settled: outcome.settled, value: outcome.value };
  await rig.scheduler.advance(60_000);
  expect({
    before,
    atDeadline,
    calls: rig.calls.length,
    aborted: rig.calls[0]?.init.signal.aborted,
  }).toEqual({
    before: { settled: 'pending', calls: 1, aborted: false },
    atDeadline: { settled: 'resolved', value: 'unknown' },
    calls: 1,
    aborted: true,
  });
});

it('[AC-B1-12w#20] 供应商拒收 → rejected；HTTP 503 → unknown；都只发一次请求（不登记备用、不重试）', async () => {
  const rejected = entry(
    [json(200, { Code: 'isv.MOBILE_NUMBER_ILLEGAL', Message: 'x' }), OK_REPLY],
    CONFIG,
  );
  const failing = entry(
    [json(503, { Code: 'ServiceUnavailable', Message: 'x' }), OK_REPLY],
    CONFIG,
  );
  const outcomes = [observe(rejected.sender.send(REQUEST)), observe(failing.sender.send(REQUEST))];
  await rejected.scheduler.advance(60_000);
  await failing.scheduler.advance(60_000);
  expect({
    outcomes: outcomes.map((o) => [o.settled, o.value]),
    calls: [rejected.calls.length, failing.calls.length],
  }).toEqual({
    outcomes: [
      ['resolved', 'rejected'],
      ['resolved', 'unknown'],
    ],
    calls: [1, 1],
  });
});
