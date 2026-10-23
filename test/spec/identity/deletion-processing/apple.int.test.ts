// B1-15g: Sign in with Apple revocation (08 BR-ID-27 「失败重试 3 次后告警，不阻塞注销完成」, BR-ID-04;
// brief §9.2 #3 ②; §9.3 item 9). Outside any transaction, after the cleanup: the Apple binding's
// refresh token is decrypted and handed to the revoker with the app id; at most one attempt per
// round; success → attempts + 1 and revoked; a failure → attempts + 1, the third one is final
// (failed) with one warn line, and done is not blocked. The unconfigured revoker (what app.module
// assembles until the Apple keys exist) counts as a failure. The token never reaches a log line.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  APPLE_FAILED,
  HOUR_MS,
  at,
  close,
  oauth,
  oauthOf,
  open,
  processing,
  request,
  reset,
  warnings,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});
beforeEach(async () => {
  await reset(kit);
});

const TOKEN = 'synthetic apple refresh 0f3a';

async function appleUser() {
  const { m, row } = await processing(kit.db);
  await oauth(kit.db, m, 'wechat');
  await oauth(kit.db, m, 'apple', { appleToken: TOKEN, crypto: kit.crypto });
  return { m, row };
}

it('[AC-B1-15g#20] Apple 撤销成功：端口拿到解密后的 refresh token 与 appId，attempts=1、revoked，同轮完成并删 user_oauth', async () => {
  const { m, row } = await appleUser();
  await kit.runner().runOnce();
  const now = kit.clock.now();
  expect(kit.appleCalls).toEqual([{ appId: m.appId, refreshToken: TOKEN }]);
  expect(await request(kit.db, row.id)).toEqual({
    ...row,
    status: 'done',
    processed_at: now,
    cleaned_at: now,
    apple_revoke_attempts: 1,
    apple_revoke_result: 'revoked',
    row_version: row.row_version + 1,
    updated_at: now,
  });
  expect(await oauthOf(kit.db, m.appId)).toEqual([]);
  expect(kit.lines.join('')).not.toContain(TOKEN);
});

it('[AC-B1-15g#21] Apple 撤销连续失败：每轮一次、计数逐轮 +1 且不动 row_version；第 3 次写 failed 并 warn 一次，同轮仍置 done；之后不再调', async () => {
  const { m, row } = await appleUser();
  kit.failApple(new Error(`synthetic-apple-failure ${TOKEN}`));
  const runner = kit.runner();
  const cleanedAt = kit.clock.now();
  for (const attempts of [1, 2]) {
    kit.clock.set(at((attempts - 1) * HOUR_MS));
    await runner.runOnce();
    expect(await request(kit.db, row.id)).toEqual({
      ...row,
      cleaned_at: cleanedAt,
      apple_revoke_attempts: attempts,
    });
    expect(kit.appleCalls).toHaveLength(attempts);
    expect(warnings(kit, APPLE_FAILED)).toEqual([]);
  }
  kit.clock.set(at(2 * HOUR_MS));
  await runner.runOnce();
  const doneAt = kit.clock.now();
  expect(await request(kit.db, row.id)).toEqual({
    ...row,
    status: 'done',
    processed_at: doneAt,
    cleaned_at: cleanedAt,
    apple_revoke_attempts: 3,
    apple_revoke_result: 'failed',
    row_version: row.row_version + 1,
    updated_at: doneAt,
  });
  const failed = warnings(kit, APPLE_FAILED);
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({ app_id: m.appId, deletion_request_id: row.id });
  expect(kit.appleCalls).toEqual(
    Array.from({ length: 3 }, () => ({ appId: m.appId, refreshToken: TOKEN })),
  );
  kit.clock.set(at(3 * HOUR_MS));
  await runner.runOnce();
  expect(kit.appleCalls).toHaveLength(3);
  expect(warnings(kit, APPLE_FAILED)).toHaveLength(1);
  expect(kit.lines.join('')).not.toContain(TOKEN);
  expect(kit.lines.join('')).not.toContain('synthetic-apple-failure');
});

it('[AC-B1-15g#22] 未配置的 Apple 撤销实现按失败计（不假装成功）：attempts=1、结果仍空、单不 done', async () => {
  const { row } = await appleUser();
  await kit.runner({ apple: kit.api.unconfiguredAppleTokenRevoker() }).runOnce();
  expect(await request(kit.db, row.id)).toEqual({
    ...row,
    cleaned_at: kit.clock.now(),
    apple_revoke_attempts: 1,
  });
  expect(kit.lines.join('')).not.toContain(TOKEN);
});

it('[AC-B1-15g#23] Apple 绑定没有 refresh token → not_applicable，不调撤销端口', async () => {
  const { m, row } = await processing(kit.db);
  await oauth(kit.db, m, 'apple');
  await kit.runner().runOnce();
  expect(kit.appleCalls).toEqual([]);
  expect(await request(kit.db, row.id)).toMatchObject({
    status: 'done',
    apple_revoke_attempts: 0,
    apple_revoke_result: 'not_applicable',
  });
});
