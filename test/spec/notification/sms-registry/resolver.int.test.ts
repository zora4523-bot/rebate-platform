// 规则测试（B1-12y；BR-TEXT-20 细则「短信渠道登记与后台渠道开关」的「登记」「后台开关」「过渡」三段；
// 编排裁定 D10-316 ①、D10-337 ①②、D10-339 ⑥）：createRegisteredTemplateResolver 按
// app_id + code + variant 读 notify_templates 的在用登记，给出签名与模板 CODE。
// - 在用登记齐、channels 含 sms、该编码各变体都已登记 → 登记值；variant 缺省为 default。
// - SMS_CODE 没有在用登记 → 部署配置兜底；都没有 → undefined。
// - 其他编码没有在用登记、或 channels 不含 sms → undefined（不发），部署配置不顶替。
// - 「待测试」登记永不用来发正式短信，也不顶替部署配置。
// - 默认含短信但有变体未登记（未就绪）→ undefined，并记一行 sms_not_ready（带 app_id、code）；全部变体
//   登记后自动按登记发（每次发送都读当前的行）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  createRegisteredTemplateResolver,
  type RegisteredTemplateResolverDeps,
} from '../../../../apps/api/src/modules/notification/index.ts';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { memoryLogger } from '../../platform/queue/kit.ts';
import {
  ALERT_REG,
  DEPLOY,
  EXPIRED_REG,
  PENDING_REG,
  VERIFY_REG,
  WD_DEFAULT_REG,
  WD_MANUAL_REG,
  enable,
  linesOf,
  newAppId,
  seedTemplate,
  templateOf,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

const WD_CHANNELS = ['inbox', 'push', 'sms'] as const;

/** 每个用例自己构造（骨架在构造时就抛 NotImplemented）。 */
function rig(deploy: 'with-deploy' | 'without-deploy') {
  const db = database();
  const { logger, lines } = memoryLogger('worker');
  const deps: RegisteredTemplateResolverDeps =
    deploy === 'with-deploy' ? { db, logger, deployVerifyCode: DEPLOY } : { db, logger };
  const resolver = createRegisteredTemplateResolver(deps);
  return { db, lines, resolver };
}

it('[AC-B1-12y#1] 在用登记齐且 channels 含 sms：签名与模板 CODE 取自该 app / code / variant 的登记；variant 缺省按 default；部署配置不参与', async () => {
  const r = rig('with-deploy');
  const appId = newAppId();
  await seedTemplate(r.db, {
    appId,
    code: 'UNION_AUTH_EXPIRING',
    channels: ['sms'],
    active: ALERT_REG,
  });
  await seedTemplate(r.db, {
    appId,
    code: 'UNION_AUTH_EXPIRED',
    channels: ['sms'],
    active: EXPIRED_REG,
  });
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
    active: WD_MANUAL_REG,
  });
  const got = {
    expiring: await r.resolver.resolve({ appId, code: 'UNION_AUTH_EXPIRING' }),
    expired: await r.resolver.resolve({ appId, code: 'UNION_AUTH_EXPIRED', variant: 'default' }),
    wdImplicit: await r.resolver.resolve({ appId, code: 'WD_FAILED' }),
    wdDefault: await r.resolver.resolve({ appId, code: 'WD_FAILED', variant: 'default' }),
    wdManual: await r.resolver.resolve({ appId, code: 'WD_FAILED', variant: 'manual' }),
  };
  expect(got).toEqual({
    expiring: templateOf(ALERT_REG),
    expired: templateOf(EXPIRED_REG),
    wdImplicit: templateOf(WD_DEFAULT_REG),
    wdDefault: templateOf(WD_DEFAULT_REG),
    wdManual: templateOf(WD_MANUAL_REG),
  });
  expect(linesOf(r.lines, 'sms_not_ready')).toEqual([]);
});

it('[AC-B1-12y#2] SMS_CODE：有在用登记 → 用登记；没有在用登记（无行，或只有测试已受理的「待测试」登记）→ 部署配置兜底', async () => {
  const r = rig('with-deploy');
  const registered = newAppId();
  const pendingOnly = newAppId();
  const noRow = newAppId();
  await seedTemplate(r.db, {
    appId: registered,
    code: 'SMS_CODE',
    channels: ['sms'],
    active: VERIFY_REG,
    pending: PENDING_REG,
  });
  await seedTemplate(r.db, {
    appId: pendingOnly,
    code: 'SMS_CODE',
    channels: ['sms'],
    pending: PENDING_REG,
  });
  const got = {
    registered: await r.resolver.resolve({ appId: registered, code: 'SMS_CODE' }),
    pendingOnly: await r.resolver.resolve({ appId: pendingOnly, code: 'SMS_CODE' }),
    noRow: await r.resolver.resolve({ appId: noRow, code: 'SMS_CODE' }),
  };
  expect(got).toEqual({
    registered: templateOf(VERIFY_REG),
    pendingOnly: DEPLOY,
    noRow: DEPLOY,
  });
});

it('[AC-B1-12y#3] SMS_CODE 没有在用登记、部署配置也没有 → undefined；有在用登记时不需要部署配置', async () => {
  const r = rig('without-deploy');
  const registered = newAppId();
  const pendingOnly = newAppId();
  const noRow = newAppId();
  await seedTemplate(r.db, {
    appId: registered,
    code: 'SMS_CODE',
    channels: ['sms'],
    active: VERIFY_REG,
  });
  await seedTemplate(r.db, {
    appId: pendingOnly,
    code: 'SMS_CODE',
    channels: ['sms'],
    pending: PENDING_REG,
  });
  const got = {
    registered: await r.resolver.resolve({ appId: registered, code: 'SMS_CODE' }),
    pendingOnly: await r.resolver.resolve({ appId: pendingOnly, code: 'SMS_CODE' }),
    noRow: await r.resolver.resolve({ appId: noRow, code: 'SMS_CODE' }),
  };
  expect(got).toEqual({
    registered: templateOf(VERIFY_REG),
    pendingOnly: undefined,
    noRow: undefined,
  });
});

it('[AC-B1-12y#4] SMS_CODE 以外的编码没有在用登记 → undefined（不发）：无行、只有「待测试」登记、登记列全空都一样，部署配置不顶替', async () => {
  const r = rig('with-deploy');
  const appId = newAppId();
  await seedTemplate(r.db, {
    appId,
    code: 'UNION_AUTH_EXPIRING',
    channels: ['sms'],
    pending: PENDING_REG,
  });
  await seedTemplate(r.db, { appId, code: 'WD_FAILED', channels: WD_CHANNELS });
  const got = {
    noRow: await r.resolver.resolve({ appId, code: 'UNION_AUTH_EXPIRED' }),
    pendingOnly: await r.resolver.resolve({ appId, code: 'UNION_AUTH_EXPIRING' }),
    empty: await r.resolver.resolve({ appId, code: 'WD_FAILED' }),
  };
  expect(got).toEqual({ noRow: undefined, pendingOnly: undefined, empty: undefined });
});

it('[AC-B1-12y#5] 后台关闭短信渠道（channels 不含 sms）的编码：在用登记齐也 → undefined（不发）', async () => {
  const r = rig('with-deploy');
  const appId = newAppId();
  await seedTemplate(r.db, {
    appId,
    code: 'WD_FAILED',
    channels: ['inbox', 'push'],
    active: WD_DEFAULT_REG,
  });
  await seedTemplate(r.db, {
    appId,
    code: 'ORDER_TRACKED',
    channels: ['inbox'],
    active: WD_MANUAL_REG,
  });
  const got = {
    wdFailed: await r.resolver.resolve({ appId, code: 'WD_FAILED' }),
    orderTracked: await r.resolver.resolve({ appId, code: 'ORDER_TRACKED', variant: 'default' }),
  };
  expect(got).toEqual({ wdFailed: undefined, orderTracked: undefined });
});

it('[AC-B1-12y#6] 未就绪（D10-339 ⑥）：默认含短信、有变体没有在用登记 → 每个变体都 undefined，各记一行 sms_not_ready（带 app_id、code）；全部变体启用后自动按登记发、不再记', async () => {
  const r = rig('with-deploy');
  const appId = newAppId();
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
  const before = {
    default: await r.resolver.resolve({ appId, code: 'WD_FAILED', variant: 'default' }),
    manual: await r.resolver.resolve({ appId, code: 'WD_FAILED', variant: 'manual' }),
  };
  const notReady = linesOf(r.lines, 'sms_not_ready');
  expect({ before, lines: notReady.length }).toEqual({
    before: { default: undefined, manual: undefined },
    lines: 2,
  });
  for (const line of notReady) {
    expect(line).toMatchObject({ app_id: appId, code: 'WD_FAILED' });
  }

  await enable(r.db, { appId, code: 'WD_FAILED', variant: 'manual' }, WD_MANUAL_REG);
  const after = {
    default: await r.resolver.resolve({ appId, code: 'WD_FAILED', variant: 'default' }),
    manual: await r.resolver.resolve({ appId, code: 'WD_FAILED', variant: 'manual' }),
  };
  expect({ after, lines: linesOf(r.lines, 'sms_not_ready').length }).toEqual({
    after: { default: templateOf(WD_DEFAULT_REG), manual: templateOf(WD_MANUAL_REG) },
    lines: 2,
  });
});

it('[AC-B1-12y#7] 按 app 隔离：别的 app 的登记不让本 app 就绪，别的 app 未就绪也不拦本 app；SMS_CODE 各用各的', async () => {
  const r = rig('with-deploy');
  const ready = newAppId();
  const partial = newAppId();
  for (const variant of ['default', 'manual'] as const) {
    await seedTemplate(r.db, {
      appId: ready,
      code: 'WD_FAILED',
      variant,
      channels: WD_CHANNELS,
      active: variant === 'default' ? WD_DEFAULT_REG : WD_MANUAL_REG,
    });
  }
  await seedTemplate(r.db, {
    appId: partial,
    code: 'WD_FAILED',
    variant: 'default',
    channels: WD_CHANNELS,
    active: WD_DEFAULT_REG,
  });
  await seedTemplate(r.db, {
    appId: partial,
    code: 'WD_FAILED',
    variant: 'manual',
    channels: WD_CHANNELS,
  });
  await seedTemplate(r.db, {
    appId: ready,
    code: 'SMS_CODE',
    channels: ['sms'],
    active: VERIFY_REG,
  });
  await seedTemplate(r.db, {
    appId: ready,
    code: 'UNION_AUTH_EXPIRED',
    channels: ['sms'],
    active: EXPIRED_REG,
  });
  const got = {
    readyWd: await r.resolver.resolve({ appId: ready, code: 'WD_FAILED' }),
    partialWd: await r.resolver.resolve({ appId: partial, code: 'WD_FAILED' }),
    readyCode: await r.resolver.resolve({ appId: ready, code: 'SMS_CODE' }),
    partialCode: await r.resolver.resolve({ appId: partial, code: 'SMS_CODE' }),
    partialExpired: await r.resolver.resolve({ appId: partial, code: 'UNION_AUTH_EXPIRED' }),
  };
  expect(got).toEqual({
    readyWd: templateOf(WD_DEFAULT_REG),
    partialWd: undefined,
    readyCode: templateOf(VERIFY_REG),
    partialCode: DEPLOY,
    partialExpired: undefined,
  });
  const notReady = linesOf(r.lines, 'sms_not_ready');
  expect(notReady.map((line) => [line['app_id'], line['code']])).toEqual([[partial, 'WD_FAILED']]);
});
