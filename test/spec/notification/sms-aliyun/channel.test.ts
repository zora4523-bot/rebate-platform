// 规则测试（B1-12w；编排裁定 D10-315、D10-316）：阿里云 SendSms 通道 createAliyunSmsChannel，
// 实现 notification/resilience 的 SmsChannel 端口（提供方 'aliyun'）。签名名称与模板 CODE 由调用方
// 按模板编码给出；参数全在查询串，请求体为空；ACS3 签名用独立 oracle 复算。答复：受理 / 拒收 /
// 抛错（通道失败，交给主备框架）。期望值一律手写。
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { SmsMessage } from '../../../../apps/api/src/modules/notification/resilience/index.ts';
import {
  createAliyunSmsChannel,
  type AliyunSmsChannelDeps,
  type AliyunSmsTemplate,
} from '../../../../apps/api/src/modules/notification/sms/index.ts';
import {
  AT,
  AT_ACS,
  DEFAULT_ENDPOINT,
  OK_REPLY,
  SMS_PAIR,
  flush,
  fullText,
  json,
  lowerHeaders,
  observe,
  recomputedAuthorization,
  requestView,
  sha256,
  transport,
  type Reply,
} from './kit.ts';

const VERIFY: AliyunSmsTemplate = { signName: '测试签名', templateCode: 'SMS_000000001' };

function rig(
  replies: readonly Reply[],
  patch: Partial<AliyunSmsChannelDeps> = {},
  templates: Readonly<Record<string, AliyunSmsTemplate>> = { SMS_CODE: VERIFY },
) {
  const wire = transport(replies);
  const lookups: string[] = [];
  let nonces = 0;
  const deps: AliyunSmsChannelDeps = {
    credentials: SMS_PAIR,
    resolveTemplate: (template) => {
      lookups.push(template);
      return Object.hasOwn(templates, template) ? templates[template] : undefined;
    },
    fetch: wire.fetch,
    clock: new FixedClock(AT),
    nonce: () => `sms-nonce-${String(++nonces)}`,
    ...patch,
  };
  return { ...wire, lookups, channel: createAliyunSmsChannel(deps) };
}

function message(patch: Partial<SmsMessage> = {}): SmsMessage {
  return {
    app_id: 'app-synthetic',
    message_id: 'sms-msg-1',
    phone: '13912345678',
    template: 'SMS_CODE',
    params: { code: '042019' },
    ...patch,
  };
}

async function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ settled: 'resolved' as const, value, error: undefined }),
    (error: unknown) => ({ settled: 'rejected' as const, value: undefined, error }),
  );
}

it('[AC-B1-12w#4] 受理：一次 POST 到默认 https://dysmsapi.aliyuncs.com/，SendSms / 2017-05-25，参数全在查询串、请求体为空，签名与独立 oracle 一致；Code OK 且有 BizId → accepted', async () => {
  const r = rig([OK_REPLY]);
  expect(r.channel.provider).toBe('aliyun');
  const controller = new AbortController();
  const answer = await r.channel.send(message(), controller.signal);
  expect(answer).toEqual({ status: 'accepted', providerMessageId: 'biz-synthetic-1' });
  expect(r.calls).toHaveLength(1);
  const sent = r.calls[0];
  expect(sent).toBeDefined();
  if (sent === undefined) return;
  expect(requestView(sent)).toEqual({
    method: 'POST',
    base: DEFAULT_ENDPOINT,
    body: '',
    query: {
      params: {
        PhoneNumbers: '13912345678',
        SignName: '测试签名',
        TemplateCode: 'SMS_000000001',
        TemplateParam: '{"code":"042019"}',
        OutId: 'sms-msg-1',
      },
      count: 5,
    },
    action: 'SendSms',
    version: '2017-05-25',
    date: AT_ACS,
    payload: sha256(''),
  });
  const headers = lowerHeaders(sent.init.headers);
  expect(headers['x-acs-signature-nonce']).toBe('sms-nonce-1');
  expect(headers['authorization']).toBe(recomputedAuthorization(sent, SMS_PAIR));
  expect(r.lookups).toEqual(['SMS_CODE']);
  // 调用方的 signal 交给 fetch：中止它，请求的 signal 随之中止。
  expect(sent.init.signal.aborted).toBe(false);
  controller.abort();
  expect(sent.init.signal.aborted).toBe(true);
  expect(r.unexpectedFetch).not.toHaveBeenCalled();
  expect(fullText({ calls: r.calls, answer })).not.toContain(SMS_PAIR.accessKeySecret);
});

it('[AC-B1-12w#5] 签名名称与模板 CODE 只来自 resolveTemplate（按模板编码查）；TemplateParam 是 params 的 JSON；endpoint 可配置，签名的 host 随之改变', async () => {
  const r = rig([OK_REPLY], { endpoint: 'https://dysmsapi.example.invalid/' }, {
    SMS_CODE: VERIFY,
    site_alert: { signName: '另一个签名', templateCode: 'SMS_000000002' },
  });
  const params = { site: '站点 A', code: '7' };
  const answer = await r.channel.send(
    message({ template: 'site_alert', message_id: 'sms-msg-2', phone: '13800000000', params }),
    new AbortController().signal,
  );
  expect(answer).toEqual({ status: 'accepted', providerMessageId: 'biz-synthetic-1' });
  expect(r.calls).toHaveLength(1);
  const sent = r.calls[0];
  expect(sent).toBeDefined();
  if (sent === undefined) return;
  const view = requestView(sent);
  expect({ base: view.base, query: view.query }).toEqual({
    base: 'https://dysmsapi.example.invalid/',
    query: {
      params: {
        PhoneNumbers: '13800000000',
        SignName: '另一个签名',
        TemplateCode: 'SMS_000000002',
        TemplateParam: JSON.stringify(params),
        OutId: 'sms-msg-2',
      },
      count: 5,
    },
  });
  expect(lowerHeaders(sent.init.headers)['authorization']).toBe(
    recomputedAuthorization(sent, SMS_PAIR),
  );
  expect(r.lookups).toEqual(['site_alert']);
});

it('[AC-B1-12w#6] 模板编码查不到签名与模板 CODE → rejected，不发任何请求', async () => {
  const r = rig([OK_REPLY]);
  const answer = await r.channel.send(
    message({ template: 'not_registered' }),
    new AbortController().signal,
  );
  expect({ answer, calls: r.calls.length, lookups: r.lookups }).toEqual({
    answer: { status: 'rejected' },
    calls: 0,
    lookups: ['not_registered'],
  });
  expect(r.unexpectedFetch).not.toHaveBeenCalled();
});

it.each([
  ['200 isv.MOBILE_NUMBER_ILLEGAL', json(200, { Code: 'isv.MOBILE_NUMBER_ILLEGAL', Message: 'x' })],
  ['200 isv.BUSINESS_LIMIT_CONTROL', json(200, { Code: 'isv.BUSINESS_LIMIT_CONTROL' })],
  ['200 isv.SMS_SIGNATURE_ILLEGAL', json(200, { Code: 'isv.SMS_SIGNATURE_ILLEGAL' })],
  ['400 SignatureDoesNotMatch', json(400, { Code: 'SignatureDoesNotMatch', Message: 'x' })],
] as [string, Reply][])(
  '[AC-B1-12w#7] 供应商明确拒收（HTTP < 500 且 Code 是 OK 以外的字符串）→ rejected，只发一次请求：%s',
  async (_name, reply) => {
    const r = rig([reply, OK_REPLY]);
    const answer = await r.channel.send(message(), new AbortController().signal);
    expect({ answer, calls: r.calls.length }).toEqual({
      answer: { status: 'rejected' },
      calls: 1,
    });
    expect(fullText({ calls: r.calls, answer })).not.toContain(SMS_PAIR.accessKeySecret);
  },
);

it.each([
  ['HTTP 500 带 Code', json(500, { Code: 'ServiceUnavailable', Message: 'x' })],
  ['HTTP 503 非 JSON', { status: 503, body: '<html>unavailable</html>' }],
  ['HTTP 200 非 JSON', { status: 200, body: 'not json' }],
  ['HTTP 200 JSON 为 null', { status: 200, body: 'null' }],
  ['HTTP 200 缺 Code', json(200, { Message: 'OK', BizId: 'biz-synthetic-1' })],
  ['HTTP 200 Code 不是字符串', json(200, { Code: 200, BizId: 'biz-synthetic-1' })],
  ['HTTP 200 Code OK 但缺 BizId', json(200, { Code: 'OK', Message: 'OK' })],
  ['HTTP 200 Code OK 但 BizId 为空串', json(200, { Code: 'OK', BizId: '' })],
  ['HTTP 400 非 JSON', { status: 400, body: 'bad request' }],
  ['fetch 抛错', 'throw'],
] as [string, Reply][])(
  '[AC-B1-12w#8] 通道失败一律抛错（不当受理、也不当拒收），只发一次请求，错误里不含 AccessKeySecret：%s',
  async (_name, reply) => {
    const r = rig([reply, OK_REPLY]);
    const outcome = await settled(r.channel.send(message(), new AbortController().signal));
    expect({ settled: outcome.settled, calls: r.calls.length }).toEqual({
      settled: 'rejected',
      calls: 1,
    });
    expect(fullText(outcome.error)).not.toContain(SMS_PAIR.accessKeySecret);
  },
);

it('[AC-B1-12w#9] 调用方 signal 中止：挂起的请求随之中止，send 以错误结束，只发过一次请求', async () => {
  const r = rig(['hang', OK_REPLY]);
  const controller = new AbortController();
  const pending = observe(r.channel.send(message(), controller.signal));
  await flush();
  const before = {
    settled: pending.settled,
    calls: r.calls.length,
    aborted: r.calls[0]?.init.signal.aborted,
  };
  controller.abort();
  await flush();
  expect({
    before,
    settled: pending.settled,
    calls: r.calls.length,
    aborted: r.calls[0]?.init.signal.aborted,
  }).toEqual({
    before: { settled: 'pending', calls: 1, aborted: false },
    settled: 'rejected',
    calls: 1,
    aborted: true,
  });
  expect(fullText(pending.error)).not.toContain(SMS_PAIR.accessKeySecret);
});
