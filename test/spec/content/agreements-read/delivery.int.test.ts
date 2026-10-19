import { expect, it } from 'vitest';
import { createAgreementReader } from '../../../../apps/api/src/modules/content/index.ts';
import { newAppId, read, seedAgreement, success, useHarness, validate } from './kit.ts';

const h = useHarness('delivery', () => import('@couli/db/testing'));

it('[AC-F1-02n#6] 无令牌和设备头可读两类当前版本，完整通过响应契约且不泄露劳务协议', async () => {
  const appId = newAppId();
  await seedAgreement(h.db, appId, 'privacy', 1, { publishedAt: '2031-03-03T00:00:00Z' });
  await seedAgreement(h.db, appId, 'agreement', 1, { publishedAt: '2031-03-03T00:00:00Z' });
  const privacy = await seedAgreement(h.db, appId, 'privacy', 2, { minVersion: 2 });
  const agreement = await seedAgreement(h.db, appId, 'agreement', 3, { minVersion: 2 });
  await seedAgreement(h.db, appId, 'labor_agreement', 7);
  expect(await success(h.app, appId)).toEqual({ privacy, agreement });
});

it('[AC-F1-02n#7] 只发布 privacy 时 agreement 为 null', async () => {
  const appId = newAppId();
  const privacy = await seedAgreement(h.db, appId, 'privacy', 1);
  expect(await success(h.app, appId)).toEqual({ privacy, agreement: null });
});

it('[AC-F1-02n#8] 只发布 agreement 时 privacy 为 null', async () => {
  const appId = newAppId();
  const agreement = await seedAgreement(h.db, appId, 'agreement', 1);
  expect(await success(h.app, appId)).toEqual({ privacy: null, agreement });
});

it('[AC-F1-02n#9] 两类未发布时均为 null，即使已有劳务协议或其他应用协议', async () => {
  const appId = newAppId();
  await seedAgreement(h.db, appId, 'labor_agreement', 1);
  const otherApp = newAppId();
  await seedAgreement(h.db, otherApp, 'privacy', 2);
  await seedAgreement(h.db, otherApp, 'agreement', 2);
  expect(await success(h.app, appId)).toEqual({ privacy: null, agreement: null });
});

it('[AC-F1-02n#10] 已缓存匿名响应仍拒绝 deletion_only 令牌并返回 10405', async () => {
  const appId = newAppId();
  await seedAgreement(h.db, appId, 'privacy', 1);
  const restricted = await h.restrictedHeaders(appId);
  const anonymous = await success(h.app, appId);
  expect(anonymous.privacy?.version).toBe(1);
  const response = await read(h.app, appId, restricted);
  expect(response.statusCode).toBe(403);
  expect(response.json().code).toBe(10405);
  await validate(response);
  expect(await success(h.app, appId)).toEqual(anonymous);
});

it('[AC-F1-02n#11] HTTP 缓存 59999ms 内保持旧版，到 60000ms 刷新，命中不续期', async () => {
  const appId = newAppId();
  const privacy1 = await seedAgreement(h.db, appId, 'privacy', 1);
  const agreement1 = await seedAgreement(h.db, appId, 'agreement', 1);
  expect(await success(h.app, appId)).toEqual({ privacy: privacy1, agreement: agreement1 });
  const privacy2 = await seedAgreement(h.db, appId, 'privacy', 2);
  const agreement2 = await seedAgreement(h.db, appId, 'agreement', 2);
  h.clock.advanceMs(59_999);
  expect(await success(h.app, appId)).toEqual({ privacy: privacy1, agreement: agreement1 });
  h.clock.advanceMs(1);
  expect(await success(h.app, appId)).toEqual({ privacy: privacy2, agreement: agreement2 });
});

it('[AC-F1-02n#12] HTTP 缓存按 app_id 隔离，交替请求不会串应用', async () => {
  const a = newAppId();
  const b = newAppId();
  const privacyA = await seedAgreement(h.db, a, 'privacy', 2);
  const agreementA = await seedAgreement(h.db, a, 'agreement', 3);
  const privacyB = await seedAgreement(h.db, b, 'privacy', 1);
  expect(await success(h.app, a)).toEqual({ privacy: privacyA, agreement: agreementA });
  expect(await success(h.app, b)).toEqual({ privacy: privacyB, agreement: null });
  expect(await success(h.app, a)).toEqual({ privacy: privacyA, agreement: agreementA });
});

it('[AC-F1-02n#13] HTTP 缓存 null 到期后刷新，且不影响端口即时看到首次发布', async () => {
  const appId = newAppId();
  expect(await success(h.app, appId)).toEqual({ privacy: null, agreement: null });
  const privacy = await seedAgreement(h.db, appId, 'privacy', 1);
  const reader = createAgreementReader({ db: h.db });
  expect(await reader.currentAgreement(appId, 'privacy')).toMatchObject({ version: 1 });
  expect(await success(h.app, appId)).toEqual({ privacy: null, agreement: null });
  h.clock.advanceMs(60_000);
  expect(await success(h.app, appId)).toEqual({ privacy, agreement: null });
});
