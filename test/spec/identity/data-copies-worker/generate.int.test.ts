// B1-27h（08 BR-ID-40 细则「交付（默认）」「企业微信会话交付的下载」「副本请求与注销状态」、BR-ID-30 ⑨、
// BR-TEXT-23 细则「个人信息副本的交付通知」；brief §9 ①–④）：data-copy 队列的 generate 作业，在克隆的测试库
// 上以 couli_app 运行（kit 的受控端口）。
// - in_app_sms：pending → delivered；文件是用一次性提取码加密的 AES-256 ZIP，提取码只经短信（DATA_COPY_CODE）
//   发到绑定手机号，站内信 DATA_COPY_READY 只带 App 内副本页 DataCopy 的入口、正文不带链接；短信与站内信都
//   成功才记 delivered，任一失败置 failed，不留半交付。
// - wecom_session：pending → ready；文件按服务端密钥封存，不发短信与站内信（第一次下载才交付，B1-27i）。
// - expires_at = generated_at + 24 小时，完成的同一事务入队延时 expire 作业；生成、交付各一条审计。
// - 至少一次投递：重复、迟到与无效的作业什么也不改；租约内的 running 只排一次延时复查；租约过期后接手的
//   运行用自己的对象键，被接手的旧运行在完成前校验令牌，什么也写不进、不发短信、不留下文件。
// - 提取码不落库、不进日志、审计、站内信与队列。
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ExportStoreUnavailableError } from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import type { JobPayload } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { seedRequest, settledOrWaiting } from '../deletion-processing/kit.ts';
import {
  AUDIT,
  DAY_MS,
  EXPIRE,
  GENERATE,
  HOUR_MS,
  INBOX_CODE,
  MINUTE_MS,
  PHONE,
  QUEUE,
  ROUTE,
  SENTINEL,
  SMS_TEMPLATE,
  at,
  close,
  entriesText,
  expectedValues,
  fieldCrypto,
  fixture,
  identity,
  isAes256,
  open,
  openAesZip,
  text,
  zipFileEntries,
  type Base,
  type CopyRow,
  type Fixture,
} from './kit.ts';

const TIMEOUT = 120_000;
let database: TestDatabase | undefined;
let base: Base | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  base = await open(database);
}, TIMEOUT);

afterAll(async () => {
  try {
    await close(base);
  } finally {
    await database?.drop();
  }
});

function harness(): Base {
  if (base === undefined) throw new Error('the test database is not open');
  return base;
}

/** Every section was read, each for the copy's member only. */
function expectReadsOf(f: Fixture, row: CopyRow) {
  const sections = new Set(f.reads.map((item) => item.section));
  for (const section of [
    'account',
    'realname',
    'consents',
    'orders',
    'ledger',
    'withdrawals',
    'agent',
    'invite',
  ]) {
    expect(sections.has(section), section).toBe(true);
  }
  for (const item of f.reads) {
    expect(item.subject).toEqual({ appId: row.app_id, userId: row.user_id });
  }
}

/** The SMS code of the only message sent (08 and the contract leave its format open). */
function codeOf(f: Fixture): string {
  expect(f.sms.outbox).toHaveLength(1);
  const code = f.sms.outbox[0]!.params['code'];
  expect(typeof code).toBe('string');
  expect(code!.length).toBeGreaterThan(0);
  return code!;
}

/** A failed request left nothing behind: no file, no SMS, no inbox, no delivery. */
async function expectFailedClean(f: Fixture, row: CopyRow) {
  const after = await f.row(row.id);
  expect(after.status).toBe('failed');
  expect(after.failure_reason).toEqual(expect.any(String));
  expect(after.failure_reason!.trim()).not.toBe('');
  expect(after.failure_reason).not.toContain(SENTINEL);
  expect(after.delivered_at).toBeNull();
  expect(f.liveKeys()).toEqual([]);
  expect(await f.inbox(row.user_id)).toEqual([]);
  expect(f.lines.join('\n')).not.toContain(SENTINEL);
  const audits = await f.audits(row.id);
  expect(text(audits)).not.toContain('"delivered"');
  expect(text(audits)).toContain('failed');
  return after;
}

it('[AC-B1-27h#10] in_app_sms：pending → delivered；文件是用短信提取码加密的 AES-256 ZIP、导出范围齐全；提取码短信（DATA_COPY_CODE）发到绑定手机号；站内信 DATA_COPY_READY 只带 DataCopy 入口、不带链接；expires_at = generated_at + 24 小时并同事务入队 expire；生成、交付各一条审计；提取码哪里都不留', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const m = f.useCopy();
  const u = await f.user();
  const row = await f.copy({ userId: u.uid, delivery: 'in_app_sms' });
  // Reading the content takes two minutes: generated_at is when the file exists, not the claim.
  f.onRead(() => f.clock.advanceMs(2 * MINUTE_MS));
  await worker.handle(f.job(GENERATE, row.id));

  const after = await f.row(row.id);
  expect(after).toMatchObject({
    status: 'delivered',
    delivery: 'in_app_sms',
    failure_reason: null,
    requested_by: f.registrant,
    retry_of: null,
    due_at: row.due_at,
  });
  expect(after.generated_at!.getTime()).toBeGreaterThanOrEqual(at(2 * MINUTE_MS).getTime());
  expect(after.expires_at!.getTime() - after.generated_at!.getTime()).toBe(DAY_MS);
  expect(after.delivered_at!.getTime()).toBeGreaterThanOrEqual(after.generated_at!.getTime());
  expect(after.object_key).toEqual(expect.any(String));
  expectReadsOf(f, row);

  const code = codeOf(f);
  expect(f.sms.outbox[0]).toMatchObject({ appId: f.appId, phone: PHONE, template: SMS_TEMPLATE });
  expect(f.liveKeys()).toEqual([after.object_key]);
  const stored = f.store.get(after.object_key!);
  expect(stored?.contentType).toBe('application/zip');
  const files = zipFileEntries(stored!.bytes);
  expect(files.length).toBeGreaterThan(0);
  for (const entry of files) expect(isAes256(entry), entry.name).toBe(true);
  const all = entriesText(openAesZip(stored!.bytes, code));
  for (const value of expectedValues(m)) expect(all, value).toContain(value);

  const inbox = await f.inbox(u.uid);
  expect(inbox).toHaveLength(1);
  expect(inbox[0]!.code).toBe(INBOX_CODE);
  const route = inbox[0]!.route as unknown as {
    readonly route?: unknown;
    readonly params?: Record<string, unknown>;
  } | null;
  expect(route?.route).toBe(ROUTE);
  expect(Object.keys(route?.params ?? {})).toEqual([]);
  expect(inbox[0]!.body).toContain('个人信息副本');
  const visible = `${inbox[0]!.title}\n${inbox[0]!.body}`;
  expect(visible).not.toMatch(/https?:|:\/\/|www\./i);
  expect(visible).not.toContain(after.object_key!);
  const pushes = (await f.notifyLogs(u.uid)).filter(
    (log) => log.channel === 'push' && log.code === INBOX_CODE,
  );
  expect(pushes).toHaveLength(1);

  const expires = f.sends().filter((job) => job.name === EXPIRE);
  expect(expires).toEqual([
    {
      queue: QUEUE,
      name: EXPIRE,
      payload: expect.objectContaining({ appId: f.appId, copyId: row.id }),
      delaySeconds: 86_400,
      inTransaction: true,
    },
  ]);

  const audits = await f.audits(row.id);
  const generated = audits.filter((audit) => audit.action === AUDIT.generate);
  const delivered = audits.filter((audit) => audit.action === AUDIT.deliver);
  expect(generated).toHaveLength(1);
  expect(delivered).toHaveLength(1);
  for (const audit of [...generated, ...delivered]) {
    expect(audit.admin_id).toBe(f.registrant);
    expect(text(audit)).toContain(u.uid);
  }
  expect(text(delivered[0])).toContain('in_app_sms');

  expect(await f.secretsOf(row.id, u.uid)).not.toContain(code);
  expect(f.lines.join('\n')).not.toContain(PHONE);
});

it('[AC-B1-27h#11] wecom_session：pending → ready；文件按服务端密钥封存（同一密钥打开得完整副本，另一把打不开，存储里无明文）；不发短信、不写站内信、不记交付；expires_at = generated_at + 24 小时并入队 expire；只写生成审计', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const api = await identity();
  const m = f.useCopy();
  const u = await f.user();
  const row = await f.copy({ userId: u.uid, delivery: 'wecom_session' });
  await worker.handle(f.job(GENERATE, row.id));

  const after = await f.row(row.id);
  expect(after).toMatchObject({
    status: 'ready',
    delivery: 'wecom_session',
    delivered_at: null,
    failure_reason: null,
  });
  expect(after.expires_at!.getTime() - after.generated_at!.getTime()).toBe(DAY_MS);
  expectReadsOf(f, row);
  expect(f.sms.outbox).toEqual([]);
  expect(await f.inbox(u.uid)).toEqual([]);
  expect(await f.notifyLogs(u.uid)).toEqual([]);

  expect(f.liveKeys()).toEqual([after.object_key]);
  const stored = f.store.get(after.object_key!)!;
  for (const value of expectedValues(m)) {
    expect(Buffer.from(stored.bytes).includes(value), value).toBe(false);
  }
  const all = entriesText(api.openSealedDataCopyEntries(stored.bytes, f.crypto));
  for (const value of expectedValues(m)) expect(all, value).toContain(value);
  const other = await fieldCrypto();
  expect(() => api.openSealedDataCopyEntries(stored.bytes, other)).toThrow();

  expect(f.sends().filter((job) => job.name === EXPIRE)).toEqual([
    {
      queue: QUEUE,
      name: EXPIRE,
      payload: expect.objectContaining({ appId: f.appId, copyId: row.id }),
      delaySeconds: 86_400,
      inTransaction: true,
    },
  ]);
  const audits = await f.audits(row.id);
  expect(audits.filter((audit) => audit.action === AUDIT.generate)).toHaveLength(1);
  expect(audits.filter((audit) => audit.action === AUDIT.deliver)).toEqual([]);
  expect(audits.every((audit) => audit.admin_id === f.registrant)).toBe(true);
});

it('[AC-B1-27h#12] 无效、别的 app 的、未知副本与未知作业名的投递什么也不做；有效投递生成一次，重复投递不再生成、不再发短信', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const u = await f.user();
  const row = await f.copy({ userId: u.uid, delivery: 'in_app_sms' });
  const valid = f.job(GENERATE, row.id);
  const payloads: JobPayload[] = [
    {},
    { appId: f.appId },
    { appId: f.appId, copyId: 'not-a-uuid' },
    { appId: f.appId, copyId: 42 },
    { appId: 'Not An App', copyId: row.id },
    { appId: 'other_app', copyId: row.id },
    { appId: f.appId, copyId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d09' },
  ];
  for (const payload of payloads) {
    await expect(worker.handle({ ...valid, payload }), text(payload)).resolves.toBeUndefined();
  }
  await expect(worker.handle({ ...valid, name: 'unknown' })).resolves.toBeUndefined();
  expect(await f.row(row.id)).toEqual(row);
  expect(f.reads).toEqual([]);
  expect(f.put).not.toHaveBeenCalled();
  expect(f.sms.outbox).toEqual([]);

  await worker.handle(valid);
  const done = await f.row(row.id);
  expect(done.status).toBe('delivered');
  await worker.handle(valid);
  await worker.handle(f.job(GENERATE, row.id));
  expect(await f.row(row.id)).toEqual(done);
  expect(f.put).toHaveBeenCalledTimes(1);
  expect(f.sms.outbox).toHaveLength(1);
  expect(await f.inbox(u.uid)).toHaveLength(1);
  expect((await f.audits(row.id)).filter((audit) => audit.action === AUDIT.generate)).toHaveLength(
    1,
  );
});

it('[AC-B1-27h#13] 已结束或已生成的请求（ready / delivered / failed / expired / cancelled）收到 generate 什么也不改', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const seeds = [
    { status: 'ready', delivery: 'wecom_session', objectKey: 'seeded/ready.zip' },
    { status: 'delivered', delivery: 'in_app_sms', objectKey: 'seeded/delivered.zip' },
    { status: 'failed', delivery: 'in_app_sms', failureReason: '演示失败' },
    { status: 'expired', delivery: 'in_app_sms' },
    { status: 'cancelled', delivery: 'wecom_session' },
  ] as const;
  for (const seed of seeds) {
    const u = await f.user();
    const row = await f.copy({
      userId: u.uid,
      generatedAt: at(-HOUR_MS),
      expiresAt: at(DAY_MS - HOUR_MS),
      ...seed,
    });
    await worker.handle(f.job(GENERATE, row.id));
    expect(await f.row(row.id), seed.status).toEqual(row);
  }
  expect(f.put).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.sms.outbox).toEqual([]);
  expect(f.reads).toEqual([]);
});

it('[AC-B1-27h#14] 租约内的 running（重复投递）不生成、不改行，只入队一次延时的 generate 复查', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const u = await f.user();
  const row = await f.copy({
    userId: u.uid,
    delivery: 'in_app_sms',
    status: 'running',
    rowVersion: 1,
    updatedAt: at(0),
  });
  await worker.handle(f.job(GENERATE, row.id));
  expect(await f.row(row.id)).toEqual(row);
  expect(f.reads).toEqual([]);
  expect(f.put).not.toHaveBeenCalled();
  expect(f.sms.outbox).toEqual([]);
  const retries = f.sends().filter((job) => job.name === GENERATE);
  expect(retries).toHaveLength(1);
  expect(retries[0]).toMatchObject({
    queue: QUEUE,
    payload: { appId: f.appId, copyId: row.id },
  });
  expect(retries[0]!.delaySeconds).toBeGreaterThan(0);
});

it('[AC-B1-27h#15] 租约早已过期的 running（进程中断）：再次投递后不再停在 running；交付了就恰一条短信、文件可用短信提取码打开，失败了就没有短信与文件', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  f.useCopy();
  const u = await f.user();
  const row = await f.copy({
    userId: u.uid,
    delivery: 'in_app_sms',
    status: 'running',
    rowVersion: 1,
    updatedAt: at(-DAY_MS),
  });
  await worker.handle(f.job(GENERATE, row.id));
  const after = await f.row(row.id);
  expect(['delivered', 'failed']).toContain(after.status);
  if (after.status === 'delivered') {
    const code = codeOf(f);
    expect(f.liveKeys()).toEqual([after.object_key]);
    expect(() => openAesZip(f.store.get(after.object_key!)!.bytes, code)).not.toThrow();
  } else {
    expect(f.sms.outbox).toEqual([]);
    expect(f.liveKeys()).toEqual([]);
    expect(after.failure_reason).toEqual(expect.any(String));
  }
});

it('[AC-B1-27h#16] 租约过期被接手：旧运行恢复后完成前校验令牌失败，什么也写不进、不发短信、不留文件；两次运行的对象键不同；最终交付的文件能用唯一那条短信的提取码打开', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  f.useCopy();
  const u = await f.user();
  const row = await f.copy({ userId: u.uid, delivery: 'in_app_sms' });
  const hold = f.holdRead();
  const first = worker.handle(f.job(GENERATE, row.id));
  await hold.entered;
  // The first run is stuck long past any lease; another delivery of the job comes.
  f.clock.advanceMs(DAY_MS);
  const second = worker.handle(f.job(GENERATE, row.id));
  await settledOrWaiting(f.db, second);
  hold.release();
  await Promise.all([first.catch(() => undefined), second]);

  const after = await f.row(row.id);
  expect(['delivered', 'failed']).toContain(after.status);
  const keys = f.putKeys();
  if (keys.length === 2) expect(keys[0]).not.toBe(keys[1]);
  if (after.status === 'delivered') {
    const code = codeOf(f);
    expect(f.liveKeys()).toEqual([after.object_key]);
    expect(() => openAesZip(f.store.get(after.object_key!)!.bytes, code)).not.toThrow();
    expect(await f.inbox(u.uid)).toHaveLength(1);
  } else {
    expect(f.sms.outbox).toEqual([]);
    expect(f.liveKeys()).toEqual([]);
  }
  // Nothing the old run could still do changes the outcome.
  await worker.handle(f.job(GENERATE, row.id));
  expect(await f.row(row.id)).toEqual(after);
});

it.each([
  ['in_app_sms', 'source'],
  ['in_app_sms', 'store'],
  ['wecom_session', 'source'],
  ['wecom_session', 'store'],
] as const)(
  '[AC-B1-27h#17] %s 生成失败（%s：取数抛错 / 存储不可用 ExportStoreUnavailableError）→ failed（failure_reason 不带错误详情），不发短信、不写站内信、不留文件；生成审计记失败；日志不带错误详情',
  async (delivery, failure) => {
    const f = await fixture(harness());
    const worker = await f.worker();
    const u = await f.user();
    const row = await f.copy({ userId: u.uid, delivery });
    if (failure === 'source') f.failRead(new Error(SENTINEL));
    else f.put.mockRejectedValueOnce(new ExportStoreUnavailableError());
    await worker.handle(f.job(GENERATE, row.id)).catch(() => undefined);
    await expectFailedClean(f, row);
    expect(f.sms.outbox).toEqual([]);
    const audits = await f.audits(row.id);
    const generated = audits.filter((audit) => audit.action === AUDIT.generate);
    expect(generated).toHaveLength(1);
    expect(generated[0]!.admin_id).toBe(f.registrant);
    expect(text(generated[0])).toContain('failed');
    expect(audits.filter((audit) => audit.action === AUDIT.deliver)).toEqual([]);
  },
);

it.each(['rejected', 'throws'] as const)(
  '[AC-B1-27h#18] in_app_sms 提取码短信发送失败（%s）→ failed，文件删除、不写站内信、不记交付，不留半交付',
  async (outcome) => {
    const f = await fixture(harness());
    const worker = await f.worker();
    const u = await f.user();
    const row = await f.copy({ userId: u.uid, delivery: 'in_app_sms' });
    f.sms.answers.push(outcome === 'rejected' ? 'rejected' : new Error(SENTINEL));
    await worker.handle(f.job(GENERATE, row.id)).catch(() => undefined);
    await expectFailedClean(f, row);
    expect(f.sms.outbox).toHaveLength(1);
    expect(await f.notifyLogs(u.uid)).toEqual([]);
  },
);

it('[AC-B1-27h#19] in_app_sms 站内信写入失败 → failed，文件删除、不记交付', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const u = await f.user();
  const row = await f.copy({ userId: u.uid, delivery: 'in_app_sms' });
  f.failInbox(new Error(SENTINEL));
  await worker.handle(f.job(GENERATE, row.id)).catch(() => undefined);
  await expectFailedClean(f, row);
});

it('[AC-B1-27h#20] in_app_sms 生成时已无绑定手机号 → failed，不发短信、不写站内信、不留文件', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  f.useCopy(undefined, null);
  const u = await f.user();
  const row = await f.copy({ userId: u.uid, delivery: 'in_app_sms' });
  await worker.handle(f.job(GENERATE, row.id)).catch(() => undefined);
  await expectFailedClean(f, row);
  expect(f.sms.outbox).toEqual([]);
});

it('[AC-B1-27h#21] 注销状态：已进入 processing 的账号不再生成与交付（cancelled 或 failed，无短信、无站内信、无文件）；冷静期（cooling）照常交付', async () => {
  const f = await fixture(harness());
  const worker = await f.worker();
  const deleting = await f.user('deleting');
  await seedRequest(f.db, deleting, { status: 'processing' });
  const gone = await f.copy({ userId: deleting.uid, delivery: 'in_app_sms' });
  await worker.handle(f.job(GENERATE, gone.id)).catch(() => undefined);
  const stopped = await f.row(gone.id);
  expect(['cancelled', 'failed']).toContain(stopped.status);
  expect(stopped.delivered_at).toBeNull();
  expect(f.sms.outbox).toEqual([]);
  expect(f.liveKeys()).toEqual([]);
  expect(await f.inbox(deleting.uid)).toEqual([]);

  const cooling = await f.user();
  await seedRequest(f.db, cooling, { status: 'cooling' });
  const kept = await f.copy({ userId: cooling.uid, delivery: 'in_app_sms' });
  await worker.handle(f.job(GENERATE, kept.id));
  expect((await f.row(kept.id)).status).toBe('delivered');
  expect(f.sms.outbox).toHaveLength(1);
});
