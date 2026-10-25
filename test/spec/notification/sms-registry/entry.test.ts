// 规则测试（B1-12y；BR-TEXT-20 细则「短信渠道登记与后台渠道开关」的「过渡」；编排裁定 D10-316 ①、
// D10-337 ①）：装配入口 createEntrySmsSender 传了 resolver 时，验证码短信（SMS_CODE）的签名与模板 CODE
// 按消息的 app_id 从 resolver 取（resolver 自己负责部署配置兜底），不再直接用部署配置；resolver 给
// undefined → rejected，不发请求。AccessKey 仍来自部署配置。不连库、不 listen，HTTP 只走假 fetch。
import { expect, it, vi } from 'vitest';
import {
  createEntrySmsSender,
  type RegisteredTemplateResolver,
  type VerifyCodeSmsSender,
} from '../../../../apps/api/src/modules/notification/index.ts';
import type { AliyunSmsTemplate } from '../../../../apps/api/src/modules/notification/sms/index.ts';
import {
  FixedClock,
  createResilienceRegistry,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  AT,
  CONFIG,
  ManualScheduler,
  OK_REPLY,
  VERIFY_REG,
  fullText,
  lowerHeaders,
  recomputedAuthorization,
  requestView,
  templateOf,
  transport,
  type Reply,
} from './kit.ts';

const OTHER_APP: AliyunSmsTemplate = { signName: '另一登记签名', templateCode: 'SMS_100000002' };

function entry(replies: readonly Reply[], byApp: Readonly<Record<string, AliyunSmsTemplate>>) {
  const scheduler = new ManualScheduler();
  const registry = createResilienceRegistry();
  const wire = transport(replies);
  const resolve = vi.fn<RegisteredTemplateResolver['resolve']>(async (query) =>
    query.code === 'SMS_CODE' && Object.hasOwn(byApp, query.appId) ? byApp[query.appId] : undefined,
  );
  const fallbackSender: VerifyCodeSmsSender = { send: vi.fn(async () => 'rejected' as const) };
  const fallback = vi.fn(() => fallbackSender);
  let ids = 0;
  let nonces = 0;
  const sender = createEntrySmsSender({
    sms: CONFIG,
    resolver: { resolve },
    fallback,
    registry,
    scheduler,
    fetch: wire.fetch,
    clock: new FixedClock(AT),
    nonce: () => `sms-nonce-${String(++nonces)}`,
    messageId: () => `vc-msg-${String(++ids)}`,
  });
  return { ...wire, resolve, fallback, sender };
}

function request(app_id: string) {
  return { app_id, phone: '13912345678', purpose: 'login' as const, code: '042019' };
}

it('[AC-B1-12y#15] 有 resolver：SMS_CODE 的 SignName / TemplateCode 按消息的 app_id 取自 resolver（各 app 各用各的登记，不是部署配置）；凭据仍是部署配置', async () => {
  const rig = entry([OK_REPLY, OK_REPLY], {
    couli: templateOf(VERIFY_REG),
    'couli-other': OTHER_APP,
  });
  const first = await rig.sender.send(request('couli'));
  const second = await rig.sender.send(request('couli-other'));
  expect({ first, second, calls: rig.calls.length }).toEqual({
    first: 'accepted',
    second: 'accepted',
    calls: 2,
  });
  const sent = rig.calls.map((call) => {
    const params = requestView(call).query.params;
    return [params['SignName'], params['TemplateCode'], params['TemplateParam']];
  });
  expect(sent).toEqual([
    [VERIFY_REG.signName, VERIFY_REG.templateCode, '{"code":"042019"}'],
    [OTHER_APP.signName, OTHER_APP.templateCode, '{"code":"042019"}'],
  ]);
  const queried = rig.resolve.mock.calls.map(([query]) => [query.appId, query.code]);
  expect(queried).toContainEqual(['couli', 'SMS_CODE']);
  expect(queried).toContainEqual(['couli-other', 'SMS_CODE']);
  for (const call of rig.calls) {
    expect(lowerHeaders(call.init.headers)['authorization']).toBe(
      recomputedAuthorization(call, {
        accessKeyId: CONFIG.accessKeyId,
        accessKeySecret: CONFIG.accessKeySecret,
      }),
    );
  }
  expect(rig.fallback).not.toHaveBeenCalled();
  expect(rig.unexpectedFetch).not.toHaveBeenCalled();
  expect(fullText(rig.calls)).not.toContain(CONFIG.accessKeySecret);
});

it('[AC-B1-12y#16] 有 resolver 而它给 undefined（该 app 没有在用登记、也没有部署兜底）→ rejected，不发请求，入口自己不拿部署配置顶替', async () => {
  const rig = entry([OK_REPLY], { couli: templateOf(VERIFY_REG) });
  const delivery = await rig.sender.send(request('app-without-registration'));
  expect({ delivery, calls: rig.calls.length }).toEqual({ delivery: 'rejected', calls: 0 });
  expect(rig.resolve).toHaveBeenCalled();
  expect(rig.resolve.mock.calls.map(([query]) => [query.appId, query.code])).toContainEqual([
    'app-without-registration',
    'SMS_CODE',
  ]);
  expect(rig.unexpectedFetch).not.toHaveBeenCalled();
});
