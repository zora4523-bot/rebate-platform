import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FIELD_CRYPTO, type FieldCrypto } from '../../../../apps/api/src/modules/platform/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { acquireRedis, memoryLogger, phone, type TestRedis } from '../../identity/sms-codes/kit.ts';
import {
  buildApp,
  device,
  outbox,
  validateErrorResponse,
  type HttpApp,
  type Response,
} from '../../identity/sms-codes/http-kit.ts';
import { client, validate } from '../../identity/sms-login/http-kit.ts';
import { rows } from '../../identity/sms-login/kit.ts';
import {
  closeKit,
  expectRegistrationHit,
  hits,
  openKit,
  phoneHmac,
  seedBlock,
  seedUser,
  UUID_V7,
  type Kit,
} from './kit.ts';

let kit: Kit;
let redis: TestRedis | undefined;
let app: HttpApp;
let dir: string | undefined;
const clock = new FixedClock('2026-10-08T04:00:00.000Z');
const { logger, lines } = memoryLogger();
beforeAll(async () => {
  kit = await openKit();
  redis = await acquireRedis();
  if (redis === undefined) return;
  const base = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'spec-b1-03d-'));
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

async function prepared(prefix = '139') {
  expect(redis).toBeDefined();
  expect(app).toBeDefined();
  const c = await client(app, clock);
  const number = phone(prefix);
  return { c, number, crypto: app.get<FieldCrypto>(FIELD_CRYPTO) };
}

function blocked(response: Response, msg?: string) {
  expect(response.statusCode).toBe(403);
  const body = response.json<{ code: number; trace_id: string; msg: string; data?: unknown }>();
  expect(body).toMatchObject({
    code: 44001,
    trace_id: expect.any(String),
    msg: expect.any(String),
  });
  if (msg !== undefined) expect(body.data).toEqual({ risk_msg_code: msg });
  else if (body.data !== undefined && body.data !== null) {
    // Existing prefix/device-limit decisions have no configured message code today.
    expect(Object.keys(body.data)).toEqual(['risk_msg_code']);
  }
}

it('[AC-B1-03d#17][BR-ID-05/31/36][04 §7] 真签名发码接入黑名单，44001 过 4XX schema、没有额度与发送副作用', async () => {
  const { c, number, crypto } = await prepared();
  const digest = phoneHmac(crypto, number);
  const id = await seedBlock(kit.db, 'couli', 'phone', digest, clock);
  const count = outbox(app).length;
  const response = await c.send(number);
  blocked(response, 'blocklist.fraud_invite');
  await validateErrorResponse(response);
  expect(outbox(app)).toHaveLength(count);
  await expectRegistrationHit(kit.db, {
    app: 'couli',
    crypto,
    clock,
    phone: number,
    dimension: 'phone',
    value_hmac: digest,
    rule: 'BLACKLIST_PHONE',
  });
  expect(lines.join('') + JSON.stringify(response.json())).not.toContain(number);
  await sql`UPDATE app.blocklist SET status = 'inactive' WHERE id = ${id}`.execute(kit.db);
  expect((await c.send(number)).json()).toMatchObject({ code: 0 });
  expect(outbox(app)).toHaveLength(count + 1);
});

it('[AC-B1-03d#18][BR-ID-05/36] 号段判定照旧，真实 HTTP 44001 必须补 phone_prefix 命中', async () => {
  const { c, number, crypto } = await prepared('170');
  const count = outbox(app).length;
  const response = await c.send(number);
  blocked(response);
  await validateErrorResponse(response);
  expect(outbox(app)).toHaveLength(count);
  await expectRegistrationHit(kit.db, {
    app: 'couli',
    crypto,
    clock,
    phone: number,
    dimension: 'phone_prefix',
    value_hmac: phoneHmac(crypto, number),
    rule: 'SMS_BLOCKED_PREFIX',
  });
});

async function loginReady(preparedClient?: Awaited<ReturnType<typeof prepared>>) {
  const f = preparedClient ?? (await prepared());
  expect((await f.c.send(f.number)).json()).toMatchObject({ code: 0 });
  const message = outbox(app).findLast((m) => m.phone === f.number);
  expect(message).toBeDefined();
  return {
    ...f,
    body: {
      phone: f.number,
      code: message!.code,
      legal_versions: { privacy: 3, agreement: 2 },
      consent_at: new Date(clock.now().getTime() - 5000).toISOString(),
    },
  };
}

it('[AC-B1-03d#19][BR-ID-31/36][04 §7] 发码后登记黑名单，真签名登录 44001 无用户/同意/日志/会话写入，命中留存', async () => {
  const f = await loginReady();
  const digest = phoneHmac(f.crypto, f.number);
  await seedBlock(kit.db, 'couli', 'phone', digest, clock);
  const before = await rows(kit, 'couli');
  const response = await f.c.login(f.body);
  blocked(response, 'blocklist.fraud_invite');
  await validate(response, false);
  expect(await rows(kit, 'couli')).toEqual(before);
  await expectRegistrationHit(kit.db, {
    app: 'couli',
    crypto: f.crypto,
    clock,
    phone: f.number,
    dimension: 'phone',
    value_hmac: digest,
    rule: 'BLACKLIST_PHONE',
  });
  expect(lines.join('') + JSON.stringify(response.json())).not.toContain(f.number);
});

it('[AC-B1-03d#20][BR-ID-05/36] 设备满额登录默认拒绝，savepoint 与登录回滚后保留 device 命中', async () => {
  const f = await loginReady();
  for (let i = 0; i < 3; i++) {
    const uid = await seedUser(kit.db, 'couli');
    // Seed each record with the injected time, independent of the container wall clock.
    await sql`INSERT INTO app.device_registrations
      (app_id, device_hash, user_id, register_method, created_at)
      VALUES ('couli', ${f.c.deviceHash}, ${uid}, 'sms', ${clock.now()})`.execute(kit.db);
  }
  const before = await rows(kit, 'couli');
  const response = await f.c.login(f.body);
  blocked(response);
  await validate(response, false);
  expect(await rows(kit, 'couli')).toEqual(before);
  await expectRegistrationHit(kit.db, {
    app: 'couli',
    crypto: f.crypto,
    clock,
    phone: f.number,
    dimension: 'device',
    value_hmac: f.c.deviceHash,
    rule: 'DEVICE_REGISTER_LIMIT',
  });
});

it('[AC-B1-03d#22][BR-ID-31/36][04 §7] 设备黑名单上的新设备用干净号码发码成功，真签名注册被拦且无业务写入', async () => {
  const preparedClient = await prepared();
  await seedBlock(kit.db, 'couli', 'device', preparedClient.c.deviceHash, clock);
  // Blacklist is present before sending; the clean phone can receive an SMS.
  // This new device has no registrations, so the device-count limit cannot cause the rejection.
  const f = await loginReady(preparedClient);
  expect(await hits(kit.db, 'couli', phoneHmac(f.crypto, f.number))).toEqual([]);
  const before = await rows(kit, 'couli');
  expect(before.registrations.filter((r) => r.device_hash === f.c.deviceHash)).toEqual([]);
  const response = await f.c.login(f.body);
  blocked(response, 'blocklist.fraud_invite');
  await validate(response, false);
  expect(await rows(kit, 'couli')).toEqual(before);
  await expectRegistrationHit(kit.db, {
    app: 'couli',
    crypto: f.crypto,
    clock,
    phone: f.number,
    dimension: 'device',
    value_hmac: f.c.deviceHash,
    rule: 'BLACKLIST_DEVICE',
  });
  expect(lines.join('') + JSON.stringify(response.json())).not.toContain(f.number);
});

it('[AC-B1-03d#23][BR-ID-36] 无登录态的 bind 发码命中仍留记录，请求类型和 user_id 为空', async () => {
  expect(redis).toBeDefined();
  const send = await device(app, clock);
  const number = phone('139');
  const crypto = app.get<FieldCrypto>(FIELD_CRYPTO);
  const digest = phoneHmac(crypto, number);
  await seedBlock(kit.db, 'couli', 'phone', digest, clock);
  const count = outbox(app).length;
  const response = await send({ phone: number, purpose: 'bind' });
  blocked(response, 'blocklist.fraud_invite');
  await validateErrorResponse(response);
  expect(outbox(app)).toHaveLength(count);
  const recorded = await hits(kit.db, 'couli', digest);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    app_id: 'couli',
    dimension: 'phone',
    value_hmac: digest,
    rule_id: 'BLACKLIST_PHONE',
    risk_action: 'block',
    ref_type: 'blocked_request',
    request_type: null,
    user_id: null,
    related_phone_hmac: digest,
    related_phone_masked: `${number.slice(0, 3)}****${number.slice(-4)}`,
    amount_fen: null,
    created_at: clock.now(),
  });
  expect(recorded[0]?.ref_id).toMatch(UUID_V7);
  expect(lines.join('') + JSON.stringify(response.json())).not.toContain(number);
});
