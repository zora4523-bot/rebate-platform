import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { buildApp, type HttpApp } from '../sms-codes/http-kit.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import { seedUser } from '../registration/kit.ts';
import { openSuite, closeSuite, hash, type Suite } from './kit.ts';
import { client, accepted, rejected } from './http-kit.ts';

let suite: Suite;
let app: HttpApp;
let dir: string | undefined;
const clock = new FixedClock('2026-10-08T04:00:00.000Z');
const { logger, lines } = memoryLogger();
beforeAll(async () => {
  suite = await openSuite();
  await suite.db
    .withSchema('app')
    .insertInto('app_versions')
    .values({
      id: randomUUID(),
      app_id: 'couli',
      platform: 'ios',
      channel: 'appstore',
      latest_version: '3.0.0',
      min_supported_version: '3.0.0',
      update_title: '测试',
      update_notes: '刷新作用域',
      store_url: 'https://example.invalid/app',
      default_store: 'app_store',
      store_listings: sql`'[]'::jsonb`,
    })
    .execute();
  const base = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'spec-b1-02k-'));
  app = await buildApp(suite.db, dir, suite.server.url, clock, logger);
  await app.init();
}, 180_000);
afterAll(async () => {
  try {
    await app?.close();
  } finally {
    try {
      await closeSuite(suite);
    } finally {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  }
}, 30_000);

async function prepared() {
  const c = await client(app, clock);
  const uid = await seedUser(suite.db, 'couli');
  const tokens = app.get<TokenService>(TOKEN_SERVICE);
  const db = suite.db.withSchema('app');
  const initial = await db.transaction().execute((trx) =>
    createSession(
      trx,
      {
        uid,
        app_id: 'couli',
        device_id: c.deviceId,
        scp: 'full',
      },
      { clock, tokens },
    ),
  );
  const session = () =>
    db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', '=', 'couli')
      .where('sid', '=', initial.sid)
      .executeTakeFirstOrThrow();
  const chain = () =>
    db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('app_id', '=', 'couli')
      .where('sid', '=', initial.sid)
      .orderBy('id')
      .execute();
  return { c, uid, initial, tokens, session, chain };
}

it('[AC-S1-171#2][AC-S1-83#12] 真签名200外壳；忽略坏access，低版本刷新受限，再升级恢复full', async () => {
  const f = await prepared();
  const pair = await accepted(
    await f.c.refresh(f.initial.refresh_token, {
      authorization: 'Bearer invalid-access-is-ignored',
      'x-channel': 'appstore',
      'x-app-version': '1.0.0',
    }),
  );
  expect(pair.session_scope).toBe('deletion_only');
  expect(await f.tokens.verifyAccess(pair.access_token)).toMatchObject({
    uid: f.uid,
    sid: f.initial.sid,
    scp: 'deletion_only',
  });
  const full = await accepted(
    await f.c.refresh(pair.refresh_token, {
      'x-channel': 'appstore',
      'x-app-version': '3.0.0',
    }),
  );
  expect(full.session_scope).toBe('full');
  expect(await f.tokens.verifyAccess(full.access_token)).toMatchObject({
    sid: f.initial.sid,
    scp: 'full',
  });
  for (const secret of [
    f.initial.refresh_token,
    pair.refresh_token,
    pair.access_token,
    hash(f.initial.refresh_token),
  ])
    expect(lines.join('')).not.toContain(secret);
});

it('[AC-S1-171#2][AC-S1-171#3] 真签名10秒与30秒宽限原样返回，31秒401/10404且整条吊销', async () => {
  const f = await prepared();
  const pair = await accepted(await f.c.refresh(f.initial.refresh_token));
  clock.advanceMs(10_000);
  expect(await accepted(await f.c.refresh(f.initial.refresh_token))).toEqual(pair);
  clock.advanceMs(20_000);
  expect(await accepted(await f.c.refresh(f.initial.refresh_token))).toEqual(pair);
  expect((await f.session()).revoked_at).toBeNull();
  clock.advanceMs(1000);
  await rejected(await f.c.refresh(f.initial.refresh_token), 10404);
  expect(await f.session()).toMatchObject({
    revoked_at: clock.now(),
    revoke_reason: 'refresh_reuse',
  });
  await rejected(await f.c.refresh(pair.refresh_token), 10404);
});

it('[AC-S1-171#4] D2用自己的真实签名提交D1未轮换令牌，整条吊销，D1也10404', async () => {
  const f = await prepared();
  const second = await client(app, clock);
  const before = await f.chain();
  await rejected(await second.refresh(f.initial.refresh_token), 10404);
  expect(await f.session()).toMatchObject({
    revoked_at: clock.now(),
    revoke_reason: 'refresh_reuse',
  });
  expect(await f.chain()).toEqual(before);
  await rejected(await f.c.refresh(f.initial.refresh_token), 10404);
});

it('[AC-S1-171#6] 冒用D1但无密钥10401，既不轮换也不吊销；之后合法签名仍成功', async () => {
  const f = await prepared();
  const second = await client(app, clock);
  const before = await f.session();
  const chain = await f.chain();
  await rejected(
    await second.refresh(f.initial.refresh_token, { 'x-device-id': f.c.deviceId }),
    10401,
  );
  expect(await f.session()).toEqual(before);
  expect(await f.chain()).toEqual(chain);
  const pair = await accepted(await f.c.refresh(f.initial.refresh_token));
  clock.advanceMs(31_000);
  await rejected(
    await second.refresh(f.initial.refresh_token, { 'x-device-id': f.c.deviceId }),
    10401,
  );
  expect(await f.session()).toEqual(before);
  expect((await accepted(await f.c.refresh(pair.refresh_token))).refresh_token).not.toBe(
    pair.refresh_token,
  );
});

it('[AC-S1-171#5] 真签名未知令牌10404，无会话副作用；来源app不符先10403', async () => {
  const f = await prepared();
  const before = await f.session();
  const chain = await f.chain();
  await rejected(await f.c.refresh('unknown-refresh-token'), 10404);
  await rejected(await f.c.refresh(f.initial.refresh_token, { 'x-app-id': 'other-app' }), 10403);
  expect(await f.session()).toEqual(before);
  expect(await f.chain()).toEqual(chain);
});
