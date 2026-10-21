// B1-15f «已定» 并入 + 补 (B1-15k 复审 S2-1): 08 BR-ID-27 「status=deleting 的账号用任何方式登录都返回 10007
// （data.stage=processing），不得新建账号」. SMS login meets an account with users.status=deleting
// (this task is the first writer of deleting): 10007 with data.stage=processing, no account created,
// no token issued, no login record (login_logs, sessions, refresh tokens, consents, device's last
// login) — for a full and a deletion_only (restricted) scope alike, as the third-party logins do
// ([AC-B1-02d#17]). Over HTTP the error envelope is 403 with the third-party login's message.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { FIELD_CRYPTO, type FieldCrypto } from '../../../../apps/api/src/modules/platform/index.ts';
import { PHONE_BLIND_INDEX_CONTEXT } from '../../../../apps/api/src/modules/identity/application/registration.ts';
import { acquireRedis, memoryLogger, phone, type TestRedis } from '../sms-codes/kit.ts';
import { buildApp, outbox, type HttpApp } from '../sms-codes/http-kit.ts';
import { client, validate } from '../sms-login/http-kit.ts';
import { closeKit, fixture, openKit, rows, type Kit } from '../sms-login/kit.ts';
import { seedUser } from '../registration/kit.ts';

let kit: Kit;
let redis: TestRedis | undefined;
let app: HttpApp | undefined;
let dir: string | undefined;
const clock = new FixedClock('2026-10-21T04:00:00.000Z');
const { logger } = memoryLogger();
const restrictedHeaders = { 'x-channel': 'appstore', 'x-app-version': '1.0.3' };

beforeAll(async () => {
  kit = await openKit();
  // Seed before the app is built so the content reader cannot cache a missing minimum.
  await kit.db
    .withSchema('app')
    .insertInto('app_versions')
    .values({
      id: randomUUID(),
      app_id: 'couli',
      platform: 'ios',
      channel: restrictedHeaders['x-channel'],
      latest_version: '3.0.0',
      min_supported_version: '3.0.0',
      update_title: '测试版本',
      update_notes: '注销处理中登录测试',
      store_url: 'https://example.invalid/app',
      default_store: 'app_store',
      store_listings: sql`'[]'::jsonb`,
    })
    .execute();
  redis = await acquireRedis();
  if (redis === undefined) return;
  const base = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'spec-b1-15f-'));
  app = await buildApp(kit.db, dir, redis.url, clock, logger);
  await app.init();
}, 180_000);
afterAll(async () => {
  try {
    await app?.close();
  } finally {
    try {
      await closeKit(kit);
    } finally {
      await redis?.stop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  }
});

it.each([
  { scope: 'full', minimum: null },
  { scope: 'deletion_only', minimum: '3.0.0' },
] as const)(
  '[AC-B1-15f#37][BR-ID-27] 短信登录（$scope 作用域）遇 users.status=deleting → 10007 stage=processing：不建号、不签发、不写登录记录',
  async ({ minimum }) => {
    const f = await fixture(kit);
    f.minimum.mockResolvedValue(minimum);
    const uid = await f.account('deleting');
    const before = await rows(kit, f.appId);
    const result = await f.login({ body: { ...f.command.body, invite_code: 'K7Q2MZ' } });
    expect(result).toEqual({ code: 10007, data: { stage: 'processing' } });
    expect(f.register).not.toHaveBeenCalled();
    const after = await rows(kit, f.appId);
    expect(after).toEqual(before);
    expect(after.users.map((row) => [row.id, row.status])).toEqual([[uid, 'deleting']]);
    expect(after.sessions).toEqual([]);
    expect(after.logs).toEqual([]);
  },
);

it.each([
  { scope: 'full', version: '3.0.0' },
  { scope: 'deletion_only', version: '1.0.3' },
] as const)(
  '[AC-B1-15f#38][BR-ID-27] 真签名 HTTP 短信登录（$scope）遇 deleting → 403/10007 外壳与第三方登录一致，库不变',
  async ({ version }) => {
    expect(redis, 'no test Redis').toBeDefined();
    expect(app).toBeDefined();
    const running = app!;
    const c = await client(running, clock);
    const number = phone();
    expect((await c.send(number)).statusCode).toBe(200);
    const code = outbox(running).findLast(
      (message) => message.phone === number && message.purpose === 'login',
    )!.code;
    const uid = await seedUser(kit.db, 'couli', {
      status: 'deleting',
      phoneHmac: running
        .get<FieldCrypto>(FIELD_CRYPTO)
        .blindIndex(number, PHONE_BLIND_INDEX_CONTEXT),
    });
    const before = await rows(kit, 'couli');
    const response = await c.login(
      {
        phone: number,
        code,
        legal_versions: { privacy: 7, agreement: 4 },
        consent_at: '2026-10-21T03:59:55.000Z',
      },
      { ...restrictedHeaders, 'x-app-version': version },
    );
    expect(response.statusCode, JSON.stringify(response.json())).toBe(403);
    expect(response.json()).toEqual({
      code: 10007,
      msg: '账号正在注销处理中',
      data: { stage: 'processing' },
      trace_id: expect.any(String),
    });
    await validate(response, false);
    const after = await rows(kit, 'couli');
    expect(after).toEqual(before);
    expect(after.sessions.filter((row) => row.user_id === uid)).toEqual([]);
    expect(after.logs.filter((row) => row.user_id === uid)).toEqual([]);
  },
);
