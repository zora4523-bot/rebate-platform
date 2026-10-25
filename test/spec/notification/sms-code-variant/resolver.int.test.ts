// 规则测试（B1-12za；BR-TEXT-20 细则「短信渠道登记与后台渠道开关」的「后台开关」「过渡」两段；编排裁定
// D10-337 ②，B1-12y money r1 S2）：createRegisteredTemplateResolver 对 SMS_CODE 按所请求的变体取登记。
// - 所请求变体（缺省 default）有在用登记（签名、模板 CODE 非空）→ 用它，不论该编码其他变体是否登记；
// - 该变体没有在用登记（无行，或只有「待测试」登记）→ 部署配置兜底；部署配置也没有 → undefined；
// - SMS_CODE 不看「全部变体就绪」、不看渠道开关（只能换模板、不能关），也不记 sms_not_ready；
// - 其他编码的判定不变：有变体未登记仍按未就绪不发，并记 sms_not_ready。
// 每个用例都含「所请求变体已登记、另一变体未登记」的 SMS_CODE 场景（改动前的判定在这里给部署配置）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  createRegisteredTemplateResolver,
  type RegisteredTemplateResolverDeps,
} from '../../../../apps/api/src/modules/notification/index.ts';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { memoryLogger } from '../../platform/queue/kit.ts';
import {
  DEPLOY,
  PENDING_REG,
  type PendingRegistration,
  type Registration,
  VERIFY_REG,
  WD_DEFAULT_REG,
  enable,
  linesOf,
  newAppId,
  seedTemplate,
  templateOf,
} from '../sms-registry/kit.ts';

const database = databaseFixture(createTestDatabase);

/** SMS_CODE 另一变体的在用登记（与 VERIFY_REG、部署配置都不同）。 */
const STEP_UP_REG: Registration = Object.freeze({
  signName: '登记签名乙',
  templateCode: 'SMS_100000002',
  type: 'verify',
  preview: '您的动态码为：{code}，请勿泄露！',
});

/** SMS_CODE 的「测试失败」待测试登记（sms_test_status='failed'；签名、模板 CODE 与在用登记、部署配置都不同）。 */
const FAILED_REG: PendingRegistration = Object.freeze({
  signName: '测试失败签名',
  templateCode: 'SMS_400000009',
  type: 'verify',
  preview: '测试失败的动态码 {code}',
  status: 'failed',
});

/** SMS_CODE 的待测试登记：没有站长验证手机、测试短信未发（sms_test_status='not_sent_no_verify_phone'）。 */
const NOT_SENT_REG: PendingRegistration = Object.freeze({
  signName: '未发测试签名',
  templateCode: 'SMS_400000008',
  type: 'verify',
  preview: '未发测试的动态码 {code}',
  status: 'not_sent_no_verify_phone',
});

const WD_CHANNELS = ['inbox', 'push', 'sms'] as const;

/** 每个用例自己构造。 */
function rig(deploy: 'with-deploy' | 'without-deploy') {
  const db = database();
  const { logger, lines } = memoryLogger('worker');
  const deps: RegisteredTemplateResolverDeps =
    deploy === 'with-deploy' ? { db, logger, deployVerifyCode: DEPLOY } : { db, logger };
  const resolver = createRegisteredTemplateResolver(deps);
  return { db, lines, resolver };
}

it('[AC-B1-12za#1] SMS_CODE：default 已登记、另一变体没有在用登记 → 请求 default（含缺省）用 default 的登记，不回退部署配置', async () => {
  const r = rig('with-deploy');
  const unregistered = newAppId('sms-code-variant');
  const pendingOnly = newAppId('sms-code-variant');
  await seedTemplate(r.db, {
    appId: unregistered,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    active: VERIFY_REG,
  });
  await seedTemplate(r.db, {
    appId: unregistered,
    code: 'SMS_CODE',
    variant: 'step_up',
    channels: ['sms'],
  });
  await seedTemplate(r.db, {
    appId: pendingOnly,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    active: VERIFY_REG,
  });
  await seedTemplate(r.db, {
    appId: pendingOnly,
    code: 'SMS_CODE',
    variant: 'step_up',
    channels: ['sms'],
    pending: PENDING_REG,
  });
  const got = {
    implicit: await r.resolver.resolve({ appId: unregistered, code: 'SMS_CODE' }),
    explicit: await r.resolver.resolve({
      appId: unregistered,
      code: 'SMS_CODE',
      variant: 'default',
    }),
    besidePending: await r.resolver.resolve({ appId: pendingOnly, code: 'SMS_CODE' }),
  };
  expect(got).toEqual({
    implicit: templateOf(VERIFY_REG),
    explicit: templateOf(VERIFY_REG),
    besidePending: templateOf(VERIFY_REG),
  });
  expect(linesOf(r.lines, 'sms_not_ready')).toEqual([]);
});

it('[AC-B1-12za#2] SMS_CODE：所请求变体没有在用登记（只有登记列全空的行、只有「待测试」登记、没有这一行）→ 部署配置，即使 default 已登记', async () => {
  const r = rig('with-deploy');
  const appId = newAppId('sms-code-variant');
  await seedTemplate(r.db, {
    appId,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    active: VERIFY_REG,
  });
  await seedTemplate(r.db, { appId, code: 'SMS_CODE', variant: 'step_up', channels: ['sms'] });
  await seedTemplate(r.db, {
    appId,
    code: 'SMS_CODE',
    variant: 'bind',
    channels: ['sms'],
    pending: PENDING_REG,
  });
  const got = {
    default: await r.resolver.resolve({ appId, code: 'SMS_CODE' }),
    emptyRow: await r.resolver.resolve({ appId, code: 'SMS_CODE', variant: 'step_up' }),
    pendingOnly: await r.resolver.resolve({ appId, code: 'SMS_CODE', variant: 'bind' }),
    noRow: await r.resolver.resolve({ appId, code: 'SMS_CODE', variant: 'login' }),
  };
  expect(got).toEqual({
    default: templateOf(VERIFY_REG),
    emptyRow: DEPLOY,
    pendingOnly: DEPLOY,
    noRow: DEPLOY,
  });
  expect(linesOf(r.lines, 'sms_not_ready')).toEqual([]);
});

it('[AC-B1-12za#3] SMS_CODE：非 default 变体已登记、default 未登记 → 该变体用自己的登记，default 用部署配置；各变体不串用别的变体的登记', async () => {
  const r = rig('with-deploy');
  const stepUpOnly = newAppId('sms-code-variant');
  const both = newAppId('sms-code-variant');
  await seedTemplate(r.db, {
    appId: stepUpOnly,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    pending: PENDING_REG,
  });
  await seedTemplate(r.db, {
    appId: stepUpOnly,
    code: 'SMS_CODE',
    variant: 'step_up',
    channels: ['sms'],
    active: STEP_UP_REG,
  });
  await seedTemplate(r.db, {
    appId: both,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    active: VERIFY_REG,
  });
  await seedTemplate(r.db, {
    appId: both,
    code: 'SMS_CODE',
    variant: 'step_up',
    channels: ['sms'],
    active: STEP_UP_REG,
  });
  const got = {
    stepUpOnlyDefault: await r.resolver.resolve({ appId: stepUpOnly, code: 'SMS_CODE' }),
    stepUpOnlyStepUp: await r.resolver.resolve({
      appId: stepUpOnly,
      code: 'SMS_CODE',
      variant: 'step_up',
    }),
    bothDefault: await r.resolver.resolve({ appId: both, code: 'SMS_CODE', variant: 'default' }),
    bothStepUp: await r.resolver.resolve({ appId: both, code: 'SMS_CODE', variant: 'step_up' }),
  };
  expect(got).toEqual({
    stepUpOnlyDefault: DEPLOY,
    stepUpOnlyStepUp: templateOf(STEP_UP_REG),
    bothDefault: templateOf(VERIFY_REG),
    bothStepUp: templateOf(STEP_UP_REG),
  });
});

it('[AC-B1-12za#4] SMS_CODE 没有部署配置：所请求变体已登记 → 用登记（另一变体未登记也一样）；所请求变体未登记 → undefined', async () => {
  const r = rig('without-deploy');
  const appId = newAppId('sms-code-variant');
  await seedTemplate(r.db, {
    appId,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    active: VERIFY_REG,
  });
  await seedTemplate(r.db, {
    appId,
    code: 'SMS_CODE',
    variant: 'step_up',
    channels: ['sms'],
    pending: PENDING_REG,
  });
  const got = {
    default: await r.resolver.resolve({ appId, code: 'SMS_CODE' }),
    stepUp: await r.resolver.resolve({ appId, code: 'SMS_CODE', variant: 'step_up' }),
    noRow: await r.resolver.resolve({ appId, code: 'SMS_CODE', variant: 'login' }),
  };
  expect(got).toEqual({ default: templateOf(VERIFY_REG), stepUp: undefined, noRow: undefined });
  expect(linesOf(r.lines, 'sms_not_ready')).toEqual([]);
});

it('[AC-B1-12za#5] SMS_CODE 不看渠道开关：channels 不含 sms 的行，所请求变体已登记仍用登记（另一变体未登记）；未登记的变体仍用部署配置', async () => {
  const r = rig('with-deploy');
  const appId = newAppId('sms-code-variant');
  await seedTemplate(r.db, {
    appId,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['inbox'],
    active: VERIFY_REG,
  });
  await seedTemplate(r.db, { appId, code: 'SMS_CODE', variant: 'step_up', channels: ['inbox'] });
  const got = {
    default: await r.resolver.resolve({ appId, code: 'SMS_CODE' }),
    stepUp: await r.resolver.resolve({ appId, code: 'SMS_CODE', variant: 'step_up' }),
  };
  expect(got).toEqual({ default: templateOf(VERIFY_REG), stepUp: DEPLOY });
  expect(linesOf(r.lines, 'sms_not_ready')).toEqual([]);
});

it('[AC-B1-12za#6] 其他编码不变：WD_FAILED default 已登记、manual 未登记 → 两个变体都按未就绪不发、各记一行 sms_not_ready；同一 app 同样形状的 SMS_CODE 照发登记、不记', async () => {
  const r = rig('with-deploy');
  const appId = newAppId('sms-code-variant');
  await seedTemplate(r.db, {
    appId,
    code: 'WD_FAILED',
    variant: 'default',
    channels: WD_CHANNELS,
    active: WD_DEFAULT_REG,
  });
  await seedTemplate(r.db, {
    appId,
    code: 'WD_FAILED',
    variant: 'manual',
    channels: WD_CHANNELS,
    pending: PENDING_REG,
  });
  await seedTemplate(r.db, {
    appId,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    active: VERIFY_REG,
  });
  await seedTemplate(r.db, {
    appId,
    code: 'SMS_CODE',
    variant: 'step_up',
    channels: ['sms'],
    pending: PENDING_REG,
  });
  const got = {
    wdDefault: await r.resolver.resolve({ appId, code: 'WD_FAILED', variant: 'default' }),
    wdManual: await r.resolver.resolve({ appId, code: 'WD_FAILED', variant: 'manual' }),
    codeDefault: await r.resolver.resolve({ appId, code: 'SMS_CODE' }),
    codeStepUp: await r.resolver.resolve({ appId, code: 'SMS_CODE', variant: 'step_up' }),
  };
  const notReady = linesOf(r.lines, 'sms_not_ready');
  expect({ got, notReady: notReady.map((line) => [line['app_id'], line['code']]) }).toEqual({
    got: {
      wdDefault: undefined,
      wdManual: undefined,
      codeDefault: templateOf(VERIFY_REG),
      codeStepUp: DEPLOY,
    },
    notReady: [
      [appId, 'WD_FAILED'],
      [appId, 'WD_FAILED'],
    ],
  });
});

it('[AC-B1-12za#7] SMS_CODE 每次发送都读当前的行：default 启用登记后下一次就用它，不等另一变体登记；启用前用部署配置', async () => {
  const r = rig('with-deploy');
  const appId = newAppId('sms-code-variant');
  await seedTemplate(r.db, {
    appId,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    pending: PENDING_REG,
  });
  await seedTemplate(r.db, { appId, code: 'SMS_CODE', variant: 'step_up', channels: ['sms'] });
  const before = await r.resolver.resolve({ appId, code: 'SMS_CODE' });
  await enable(r.db, { appId, code: 'SMS_CODE', variant: 'default' }, VERIFY_REG);
  const after = {
    default: await r.resolver.resolve({ appId, code: 'SMS_CODE' }),
    stepUp: await r.resolver.resolve({ appId, code: 'SMS_CODE', variant: 'step_up' }),
  };
  expect({ before, after }).toEqual({
    before: DEPLOY,
    after: { default: templateOf(VERIFY_REG), stepUp: DEPLOY },
  });
});

it('[AC-B1-12za#8] 按 app 隔离：各 app 只看自己的行，A 的 default 登记不给 B 的 default 用（B 用部署配置），B 的 step_up 登记不给 A 的 step_up 用', async () => {
  const r = rig('with-deploy');
  const partial = newAppId('sms-code-variant');
  const bare = newAppId('sms-code-variant');
  await seedTemplate(r.db, {
    appId: partial,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    active: VERIFY_REG,
  });
  await seedTemplate(r.db, {
    appId: partial,
    code: 'SMS_CODE',
    variant: 'step_up',
    channels: ['sms'],
  });
  await seedTemplate(r.db, {
    appId: bare,
    code: 'SMS_CODE',
    variant: 'step_up',
    channels: ['sms'],
    active: STEP_UP_REG,
  });
  const got = {
    partialDefault: await r.resolver.resolve({ appId: partial, code: 'SMS_CODE' }),
    partialStepUp: await r.resolver.resolve({
      appId: partial,
      code: 'SMS_CODE',
      variant: 'step_up',
    }),
    bareDefault: await r.resolver.resolve({ appId: bare, code: 'SMS_CODE' }),
    bareStepUp: await r.resolver.resolve({ appId: bare, code: 'SMS_CODE', variant: 'step_up' }),
  };
  expect(got).toEqual({
    partialDefault: templateOf(VERIFY_REG),
    partialStepUp: DEPLOY,
    bareDefault: DEPLOY,
    bareStepUp: templateOf(STEP_UP_REG),
  });
});

it('[AC-B1-12za#9] SMS_CODE：所请求变体只有「测试失败」（failed）或「未发测试」的待测试登记、在用为空 → 部署配置，绝不用待测试的签名 / 模板 CODE；同时有在用登记与 failed 待测试 → 用在用登记', async () => {
  const r = rig('with-deploy');
  const failedOnly = newAppId('sms-code-variant');
  const activeAndFailed = newAppId('sms-code-variant');
  await seedTemplate(r.db, {
    appId: failedOnly,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    pending: FAILED_REG,
  });
  await seedTemplate(r.db, {
    appId: failedOnly,
    code: 'SMS_CODE',
    variant: 'step_up',
    channels: ['sms'],
    pending: FAILED_REG,
  });
  await seedTemplate(r.db, {
    appId: failedOnly,
    code: 'SMS_CODE',
    variant: 'login',
    channels: ['sms'],
    pending: NOT_SENT_REG,
  });
  await seedTemplate(r.db, {
    appId: activeAndFailed,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    active: VERIFY_REG,
    pending: FAILED_REG,
  });
  await seedTemplate(r.db, {
    appId: activeAndFailed,
    code: 'SMS_CODE',
    variant: 'step_up',
    channels: ['sms'],
    active: STEP_UP_REG,
    pending: FAILED_REG,
  });
  const got = {
    failedOnlyDefault: await r.resolver.resolve({ appId: failedOnly, code: 'SMS_CODE' }),
    failedOnlyStepUp: await r.resolver.resolve({
      appId: failedOnly,
      code: 'SMS_CODE',
      variant: 'step_up',
    }),
    notSentOnlyLogin: await r.resolver.resolve({
      appId: failedOnly,
      code: 'SMS_CODE',
      variant: 'login',
    }),
    activeAndFailedDefault: await r.resolver.resolve({ appId: activeAndFailed, code: 'SMS_CODE' }),
    activeAndFailedStepUp: await r.resolver.resolve({
      appId: activeAndFailed,
      code: 'SMS_CODE',
      variant: 'step_up',
    }),
  };
  expect(got).toEqual({
    failedOnlyDefault: DEPLOY,
    failedOnlyStepUp: DEPLOY,
    notSentOnlyLogin: DEPLOY,
    activeAndFailedDefault: templateOf(VERIFY_REG),
    activeAndFailedStepUp: templateOf(STEP_UP_REG),
  });
  expect(linesOf(r.lines, 'sms_not_ready')).toEqual([]);
});

it('[AC-B1-12za#10] SMS_CODE 没有部署配置：所请求变体只有「测试失败」（failed）待测试登记 → undefined（待测试登记不顶替）；同时有在用登记与 failed 待测试 → 用在用登记', async () => {
  const r = rig('without-deploy');
  const appId = newAppId('sms-code-variant');
  await seedTemplate(r.db, {
    appId,
    code: 'SMS_CODE',
    variant: 'default',
    channels: ['sms'],
    active: VERIFY_REG,
    pending: FAILED_REG,
  });
  await seedTemplate(r.db, {
    appId,
    code: 'SMS_CODE',
    variant: 'step_up',
    channels: ['sms'],
    pending: FAILED_REG,
  });
  const got = {
    default: await r.resolver.resolve({ appId, code: 'SMS_CODE' }),
    stepUp: await r.resolver.resolve({ appId, code: 'SMS_CODE', variant: 'step_up' }),
  };
  expect(got).toEqual({ default: templateOf(VERIFY_REG), stepUp: undefined });
  expect(linesOf(r.lines, 'sms_not_ready')).toEqual([]);
});
