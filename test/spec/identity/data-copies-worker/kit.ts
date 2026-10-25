// B1-27h rule-test fixture (08 BR-ID-40 细则「交付（默认）」「企业微信会话交付的下载」「副本请求与注销状态」
// 「重新登记与登记人停用」, BR-ID-30 ⑨; brief §9 ①–⑦). The subjects are identity's data-copy worker and
// copy file (through identity/index.ts, imported at run time: that file carries Nest decorators;
// types come from the erasable files), the deletion processing and admin's account disable.
//
// The worker runs over the business role couli_app of a cloned test database with an injected
// FixedClock, a memory pino logger, a local FieldCrypto, the memory export store (put / delete
// spied), a recording JobQueue, a recording SMS port, notification's real push sending core (its
// channel accepts everything) behind a switchable wrapper, admin's real audit writer and fake
// PersonalDataCopySources: one known copy of every section, every read recorded with its subject,
// the account read able to run a step first (advance the clock, hold at a barrier) or to throw.
//
// The ZIP reader below is independent of the code under test: central directory, WinZip AES
// (PBKDF2-HMAC-SHA1 with 1000 iterations, AES in CTR mode with a little-endian counter from 1,
// HMAC-SHA1 authentication code of 10 bytes), stored or deflated entries.
import {
  createCipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { createDb, type DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';
import { vi } from 'vitest';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import type {
  DataCopyFileEntry,
  PersonalDataCopyContent,
} from '../../../../apps/api/src/modules/identity/application/data-copy-file.ts';
import type {
  DataCopyInbox,
  DataCopySmsMessage,
  DataCopySmsResult,
  DataCopyWorker,
  DataCopyWorkerOptions,
} from '../../../../apps/api/src/modules/identity/application/data-copy-worker.ts';
import type {
  PersonalDataCopySources,
  PersonalDataCopySubject,
} from '../../../../apps/api/src/modules/identity/ports/personal-data-copy-sources.ts';
import { createPushSendCore } from '../../../../apps/api/src/modules/notification/application/push-send.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
  type FieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  dataCopyObjectKey,
  MemoryExportStore,
} from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import type {
  JobPayload,
  ReceivedJob,
  SendOptions,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { member, type Member } from '../deletion-processing/kit.ts';

export type { Member };

interface TestDatabaseUrls {
  urlFor(role: string): string;
}

export const ROOT = new URL('../../../../', import.meta.url);
/** 2026-11-02 10:00 +08:00 (BR-ID-40 细则「例」: a Monday). */
export const NOW = '2026-11-02T02:00:00.000Z';
export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** The worker's queue and job names (brief §9 ①). */
export const QUEUE = 'data-copy';
export const GENERATE = 'generate';
export const EXPIRE = 'expire';
/** Audit actions of generation and delivery (beside the contract's user_data_copy_request / _download). */
export const AUDIT = Object.freeze({
  generate: 'user_data_copy_generate',
  deliver: 'user_data_copy_deliver',
});
/** BR-TEXT-23 细则「个人信息副本的交付通知」. */
export const INBOX_CODE = 'DATA_COPY_READY';
export const SMS_TEMPLATE = 'DATA_COPY_CODE';
export const ROUTE = 'DataCopy';

export const PHONE = '13800138000';
export const NICKNAME = '副本小狸';
export const MASKED_NAME = '**三';
export const MASKED_ID_NO = `1${'*'.repeat(16)}X`;
export const MASKED_ALIPAY = 'zh***@example.com';
/** The message of injected failures: it must reach neither failure_reason nor a log line. */
export const SENTINEL = 'sentinel-failure-detail-7f3a';

/** The export key shape (B1-34d): a copy key never has it. */
export const EXPORT_KEY_SHAPE = /^[a-z0-9_]{1,32}\/[A-Za-z0-9_-]{1,128}\.csv$/;

export type CopyRow = Selectable<DB['personal_data_copies']>;
export type CopyStatus =
  'pending' | 'running' | 'ready' | 'delivered' | 'failed' | 'expired' | 'cancelled';
export type Delivery = 'in_app_sms' | 'wecom_session';

/** Instant `ms` after NOW. */
export function at(ms: number): Date {
  return new Date(Date.parse(NOW) + ms);
}

/** JSON text of a value (bigint as decimal), to look for values that must not be there. */
export function text(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// ---- the code under test (run-time imports) ----------------------------------------------------

type WorkerApi =
  typeof import('../../../../apps/api/src/modules/identity/application/data-copy-worker.ts');
type FileApi =
  typeof import('../../../../apps/api/src/modules/identity/application/data-copy-file.ts');
type ProcessingApi =
  typeof import('../../../../apps/api/src/modules/identity/application/deletion-processing.ts');

export type IdentityCopyApi = WorkerApi & FileApi & Pick<ProcessingApi, 'createDeletionProcessing'>;

/** identity's public surface (index.ts) as far as this task goes. */
export async function identity(): Promise<IdentityCopyApi> {
  return (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as IdentityCopyApi;
}

export async function fieldCrypto(): Promise<FieldCrypto> {
  const provider = new LocalKeyProvider(randomBytes(32));
  return openFieldCrypto(await createWrappedKeyring(provider), provider);
}

// ---- the copy -------------------------------------------------------------------------------------

/** Values unique to one copy, looked for in the file. */
export interface Marks {
  readonly order: string;
  readonly title: string;
  readonly agent: string;
  readonly consent: string;
  readonly withdrawal: string;
}

export function marks(): Marks {
  const tag = randomBytes(6).toString('hex');
  return {
    order: `sub-order-${tag}`,
    title: `Copy Title ${tag}`,
    agent: `agent-said-${tag}`,
    consent: `consent_${tag}`,
    withdrawal: randomUUID(),
  };
}

/** One copy of every section (amounts in bigint fen, instants as Date, as B1-27f hands them). */
export function content(m: Marks, phone: string | null = PHONE): PersonalDataCopyContent {
  return {
    account: {
      nickname: NICKNAME,
      phone,
      login_providers: ['wechat'],
      registered_at: at(-100 * DAY_MS),
    },
    realname: {
      status: 'verified',
      masked_name: MASKED_NAME,
      masked_id_no: MASKED_ID_NO,
      verified_at: at(-20 * DAY_MS),
    },
    consents: [
      {
        type: m.consent,
        version: 3,
        channel: 'login_page',
        accepted: true,
        client_at: at(-90 * DAY_MS),
        server_at: at(-90 * DAY_MS + SECOND_MS),
      },
    ],
    orders: [
      {
        order_id: randomUUID(),
        platform: 'jd',
        sub_order_id: m.order,
        title: m.title,
        pay_amount_fen: 12345n,
        platform_status: 'PAID',
        rebate_status: 'ESTIMATED',
        paid_at: at(-3 * DAY_MS),
        created_at: at(-3 * DAY_MS),
      },
    ],
    ledger: [
      {
        ledger_type: 'REBATE_CREDIT',
        sub_type: null,
        sub_account: 'available',
        amount_fen: -1234n,
        balance_after_fen: null,
        booked_at: at(-2 * DAY_MS),
      },
    ],
    withdrawals: [
      {
        withdrawal_id: m.withdrawal,
        status: 'PAID_API',
        amount_fen: 10000n,
        fee_fen: 100n,
        tax_fen: 0n,
        net_fen: 9900n,
        payout_channel: 'alipay',
        masked_account: MASKED_ALIPAY,
        created_at: at(-DAY_MS),
        paid_at: null,
      },
    ],
    agent: [
      {
        session_id: randomUUID(),
        started_at: at(-DAY_MS),
        last_active_at: at(-DAY_MS),
        messages: [{ role: 'user', text: m.agent, created_at: at(-DAY_MS) }],
      },
    ],
    invite: { has_inviter: true },
  };
}

/** The archive's text: every entry as UTF-8, one after the other. */
export function entriesText(entries: readonly { readonly bytes: Uint8Array }[]): string {
  return entries.map((entry) => Buffer.from(entry.bytes).toString('utf8')).join('\n');
}

/** Name → hex of the bytes, sorted by name (to compare archives). */
export function digest(entries: readonly DataCopyFileEntry[]): [string, string][] {
  return entries
    .map((entry): [string, string] => [entry.name, Buffer.from(entry.bytes).toString('hex')])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** What the copy file must show of `content(m)` (the format is the implementation's). */
export function expectedValues(m: Marks): string[] {
  return [
    NICKNAME,
    PHONE,
    MASKED_NAME,
    MASKED_ID_NO,
    MASKED_ALIPAY,
    'wechat',
    m.order,
    m.title,
    m.agent,
    m.consent,
    m.withdrawal,
  ];
}

// ---- an independent ZIP reader -------------------------------------------------------------------

export interface ZipAesField {
  readonly version: number;
  readonly vendor: string;
  readonly strength: number;
  /** The actual compression method of the encrypted data. */
  readonly method: number;
}

export interface ZipEntryInfo {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly aes: ZipAesField | null;
  readonly compressedSize: number;
  readonly localOffset: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The entries of the central directory (ZIP64 sizes and offsets included). */
export function zipEntries(bytes: Uint8Array): ZipEntryInfo[] {
  const b = Buffer.from(bytes);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i -= 1) {
    if (b.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: no end of central directory record');
  let count = b.readUInt16LE(eocd + 10);
  let offset = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || b.readUInt32LE(locator) !== ZIP64_LOCATOR) {
      throw new Error('zip: no zip64 locator');
    }
    const record = Number(b.readBigUInt64LE(locator + 8));
    if (b.readUInt32LE(record) !== ZIP64_EOCD) throw new Error('zip: no zip64 end record');
    count = Number(b.readBigUInt64LE(record + 32));
    offset = Number(b.readBigUInt64LE(record + 48));
  }
  const entries: ZipEntryInfo[] = [];
  let p = offset;
  for (let n = 0; n < count; n += 1) {
    if (b.readUInt32LE(p) !== CENTRAL) throw new Error('zip: bad central directory header');
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    let compressedSize = b.readUInt32LE(p + 20);
    let uncompressedSize = b.readUInt32LE(p + 24);
    const nameLength = b.readUInt16LE(p + 28);
    const extraLength = b.readUInt16LE(p + 30);
    const commentLength = b.readUInt16LE(p + 32);
    let localOffset = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const extra = b.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    let aes: ZipAesField | null = null;
    for (let q = 0; q + 4 <= extra.length;) {
      const id = extra.readUInt16LE(q);
      const length = extra.readUInt16LE(q + 2);
      const data = extra.subarray(q + 4, q + 4 + length);
      if (id === 0x0001) {
        let r = 0;
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = Number(data.readBigUInt64LE(r));
          r += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(data.readBigUInt64LE(r));
          r += 8;
        }
        if (localOffset === 0xffffffff) localOffset = Number(data.readBigUInt64LE(r));
      }
      if (id === 0x9901 && length >= 7) {
        aes = {
          version: data.readUInt16LE(0),
          vendor: data.subarray(2, 4).toString('latin1'),
          strength: data.readUInt8(4),
          method: data.readUInt16LE(5),
        };
      }
      q += 4 + length;
    }
    entries.push({ name, flags, method, aes, compressedSize, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryData(b: Buffer, entry: ZipEntryInfo): Buffer {
  const local = entry.localOffset;
  if (b.readUInt32LE(local) !== LOCAL) throw new Error('zip: bad local file header');
  const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
  return b.subarray(start, start + entry.compressedSize);
}

/** WinZip AES: verifier, authentication code, then AES-CTR with a little-endian counter from 1. */
function aesDecrypt(data: Buffer, password: string, strength: number): Buffer {
  const keyLength = strength === 3 ? 32 : strength === 2 ? 24 : 16;
  const saltLength = keyLength / 2;
  if (data.length < saltLength + 2 + 10) throw new Error('zip: AES entry too short');
  const salt = data.subarray(0, saltLength);
  const verifier = data.subarray(saltLength, saltLength + 2);
  const body = data.subarray(saltLength + 2, data.length - 10);
  const code = data.subarray(data.length - 10);
  const derived = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, 2 * keyLength + 2, 'sha1');
  if (!derived.subarray(2 * keyLength).equals(verifier)) throw new Error('zip: wrong password');
  const expected = createHmac('sha1', derived.subarray(keyLength, 2 * keyLength))
    .update(body)
    .digest()
    .subarray(0, 10);
  if (!timingSafeEqual(expected, code)) throw new Error('zip: authentication code mismatch');
  const cipher = createCipheriv(`aes-${keyLength * 8}-ecb`, derived.subarray(0, keyLength), null);
  cipher.setAutoPadding(false);
  const out = Buffer.alloc(body.length);
  const counter = Buffer.alloc(16);
  for (let offset = 0, block = 1; offset < body.length; offset += 16, block += 1) {
    counter.fill(0);
    counter.writeBigUInt64LE(BigInt(block), 0);
    const stream = cipher.update(counter);
    for (let i = 0; i < 16 && offset + i < body.length; i += 1) {
      out[offset + i] = body.readUInt8(offset + i) ^ stream.readUInt8(i);
    }
  }
  return out;
}

/**
 * Opens an archive whose every file entry is WinZip AES encrypted (directory entries skipped);
 * throws on a wrong password, a tampered entry or an entry that is not AES encrypted.
 */
export function openAesZip(bytes: Uint8Array, password: string): DataCopyFileEntry[] {
  const b = Buffer.from(bytes);
  return zipEntries(bytes)
    .filter((entry) => !entry.name.endsWith('/'))
    .map((entry) => {
      if ((entry.flags & 1) !== 1 || entry.method !== 99 || entry.aes === null) {
        throw new Error('zip: entry is not AES encrypted');
      }
      const plain = aesDecrypt(entryData(b, entry), password, entry.aes.strength);
      if (entry.aes.method === 0) return { name: entry.name, bytes: new Uint8Array(plain) };
      if (entry.aes.method === 8) {
        return { name: entry.name, bytes: new Uint8Array(inflateRawSync(plain)) };
      }
      throw new Error('zip: unknown compression method');
    });
}

/** The file entries (directories left out) of the archive. */
export function zipFileEntries(bytes: Uint8Array): ZipEntryInfo[] {
  return zipEntries(bytes).filter((entry) => !entry.name.endsWith('/'));
}

/** Each file entry is WinZip AES (AE-1 / AE-2) with strength 3, i.e. AES-256. */
export function isAes256(entry: ZipEntryInfo): boolean {
  return (
    (entry.flags & 1) === 1 &&
    entry.method === 99 &&
    entry.aes !== null &&
    entry.aes.vendor === 'AE' &&
    (entry.aes.version === 1 || entry.aes.version === 2) &&
    entry.aes.strength === 3
  );
}

// ---- seeding ---------------------------------------------------------------------------------------

export async function admin(db: Kysely<DB>, appId: string, isSuper = false): Promise<string> {
  const id = randomUUID();
  await db
    .withSchema('app')
    .insertInto('admin_users')
    .values({
      id,
      app_id: appId,
      login_name: `dc_${id}`,
      password_hash: 'synthetic-unused',
      is_super: isSuper,
      status: 'active',
      created_at: at(-365 * DAY_MS),
      updated_at: at(-365 * DAY_MS),
    })
    .execute();
  return id;
}

export interface CopySeed {
  readonly appId: string;
  readonly userId: string;
  readonly requestedBy: string;
  readonly delivery?: Delivery;
  readonly status?: CopyStatus;
  readonly objectKey?: string | null;
  readonly generatedAt?: Date | null;
  readonly deliveredAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly failureReason?: string | null;
  readonly updatedAt?: Date;
  readonly rowVersion?: number;
}

/** A copy request written directly (synthetic fixture), read back. */
export async function seedCopy(db: Kysely<DB>, seed: CopySeed): Promise<CopyRow> {
  return db
    .withSchema('app')
    .insertInto('personal_data_copies')
    .values({
      id: randomUUID(),
      app_id: seed.appId,
      user_id: seed.userId,
      requested_by: seed.requestedBy,
      delivery: seed.delivery ?? 'in_app_sms',
      status: seed.status ?? 'pending',
      retry_of: null,
      object_key: seed.objectKey ?? null,
      due_at: at(20 * DAY_MS),
      generated_at: seed.generatedAt ?? null,
      delivered_at: seed.deliveredAt ?? null,
      expires_at: seed.expiresAt ?? null,
      failure_reason: seed.failureReason ?? null,
      row_version: seed.rowVersion ?? 0,
      created_at: at(-MINUTE_MS),
      updated_at: seed.updatedAt ?? at(-MINUTE_MS),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function copyRow(db: Kysely<DB>, id: string): Promise<CopyRow> {
  return db
    .withSchema('app')
    .selectFrom('personal_data_copies')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

/** Audit rows of the app that name the copy (in the target or the snapshots), oldest first. */
export async function auditsOf(db: Kysely<DB>, appId: string, copyId: string) {
  const rows = await db
    .withSchema('app')
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
  return rows.filter((row) => text([row.target, row.before, row.after]).includes(copyId));
}

export async function inboxOf(db: Kysely<DB>, appId: string, userId: string) {
  return db
    .withSchema('app')
    .selectFrom('inbox_messages')
    .selectAll()
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .execute();
}

export async function notifyLogsOf(db: Kysely<DB>, appId: string, userId: string) {
  return db
    .withSchema('app')
    .selectFrom('notify_logs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .execute();
}

// ---- the kit ---------------------------------------------------------------------------------------

export async function open(database: TestDatabaseUrls) {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 });
  const crypto = await fieldCrypto();
  return { db, crypto };
}
export type Base = Awaited<ReturnType<typeof open>>;

export async function close(base: Base | undefined) {
  await base?.db.destroy();
}

export interface SentJob {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly options: SendOptions;
}

/** One test's world: a fresh app with its registrant, and the worker's controlled ports. */
export async function fixture(base: Base) {
  const { db, crypto } = base;
  const appId = `dc_${randomBytes(10).toString('hex')}`;
  const registrant = await admin(db, appId);
  const clock = new FixedClock(NOW);
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const store = new MemoryExportStore({
    baseUrl: 'https://exports.example.invalid',
    signingKey: 'synthetic-data-copy-test-key',
    clock,
    logger,
  });
  const put = vi.spyOn(store, 'put');
  const remove = vi.spyOn(store, 'delete');

  const sent: SentJob[] = [];
  const queue = {
    send: vi.fn(async (name: string, job: string, payload: JobPayload, options: SendOptions) => {
      sent.push({ queue: name, name: job, payload, options });
      return randomUUID();
    }),
  };

  const sms = {
    outbox: [] as DataCopySmsMessage[],
    answers: [] as (DataCopySmsResult | Error)[],
    async send(message: DataCopySmsMessage): Promise<DataCopySmsResult> {
      sms.outbox.push({ ...message, params: { ...message.params } });
      const answer = sms.answers.shift() ?? 'accepted';
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };

  const core = createPushSendCore({
    clock,
    channel: { send: async () => ({ status: 'accepted' as const }) },
    sessionValidity: async () => new Set<string>(),
  });
  const state: {
    copy: PersonalDataCopyContent;
    readFailure: Error | undefined;
    inboxFailure: Error | undefined;
    onRead: (() => Promise<void> | void)[];
  } = { copy: content(marks()), readFailure: undefined, inboxFailure: undefined, onRead: [] };
  const inbox: DataCopyInbox = {
    record: (transaction, input) =>
      state.inboxFailure === undefined
        ? core.record(transaction, input)
        : Promise.reject(state.inboxFailure),
    dispatch: (handle, event) => core.dispatch(handle, event),
  };

  const reads: { section: string; subject: PersonalDataCopySubject }[] = [];
  function answer<T>(section: string, subject: PersonalDataCopySubject, value: T): T {
    reads.push({ section, subject: { appId: subject.appId, userId: subject.userId } });
    return value;
  }
  const sources: PersonalDataCopySources = {
    account: async (_handle, subject) => {
      answer('account', subject, null);
      const step = state.onRead.shift();
      if (step !== undefined) await step();
      if (state.readFailure !== undefined) throw state.readFailure;
      return state.copy.account;
    },
    realname: async (_handle, subject) => answer('realname', subject, state.copy.realname),
    consents: async (_handle, subject) => answer('consents', subject, state.copy.consents),
    orders: async (_handle, subject) => answer('orders', subject, state.copy.orders),
    ledger: async (_handle, subject) => answer('ledger', subject, state.copy.ledger),
    withdrawals: async (_handle, subject) => answer('withdrawals', subject, state.copy.withdrawals),
    agent: async (_handle, subject) => answer('agent', subject, state.copy.agent),
    invite: async (_handle, subject) => answer('invite', subject, state.copy.invite),
  };

  const options = (): DataCopyWorkerOptions => ({
    db,
    clock,
    queue,
    store,
    sources,
    crypto,
    sms,
    inbox,
    auditWriter: (handle, auditClock) =>
      createAuditWriter({ db: handle.withSchema('app'), clock: auditClock }),
    logger,
  });

  return {
    db,
    crypto,
    appId,
    registrant,
    clock,
    lines,
    logger,
    store,
    put,
    remove,
    sent,
    queue,
    sms,
    core,
    reads,
    options,
    /** The worker (call it in the test body: NotImplemented must fail each test). */
    async worker(): Promise<DataCopyWorker> {
      return (await identity()).createDataCopyWorker(options());
    },
    /** Sets the copy the sources answer with; returns its marks. */
    useCopy(m: Marks = marks(), phone: string | null = PHONE): Marks {
      state.copy = content(m, phone);
      return m;
    },
    /** The next account read runs `step` first. */
    onRead(step: () => Promise<void> | void) {
      state.onRead.push(step);
    },
    /** The next account read waits at a barrier: `entered` once it is there, `release` to go on. */
    holdRead() {
      const entered = deferred<void>();
      const gate = deferred<void>();
      state.onRead.push(async () => {
        entered.resolve();
        await gate.promise;
      });
      return { entered: entered.promise, release: () => gate.resolve() };
    },
    failRead(error: Error | undefined) {
      state.readFailure = error;
    },
    failInbox(error: Error | undefined) {
      state.inboxFailure = error;
    },
    /** A member of this app (users.status normal unless given). */
    user(status = 'normal'): Promise<Member> {
      return member(db, { appId, status });
    },
    copy(seed: Omit<CopySeed, 'appId' | 'requestedBy'> & { readonly requestedBy?: string }) {
      return seedCopy(db, { appId, requestedBy: registrant, ...seed });
    },
    row: (id: string) => copyRow(db, id),
    audits: (copyId: string) => auditsOf(db, appId, copyId),
    inbox: (userId: string) => inboxOf(db, appId, userId),
    notifyLogs: (userId: string) => notifyLogsOf(db, appId, userId),
    job(name: string, copyId: string, payload?: JobPayload): ReceivedJob {
      return {
        id: randomUUID(),
        queue: QUEUE,
        name,
        payload: payload ?? { appId, copyId },
        attempt: 1,
      };
    },
    /** A stored copy object of this app (seeded through the store under a copy key). */
    async storedObject(copyId: string, run = 'seed'): Promise<string> {
      const key = dataCopyObjectKey(appId, copyId, run);
      await store.put({ key, bytes: randomBytes(64), contentType: 'application/zip' });
      return key;
    },
    /** Keys that were put and still hold a file. */
    liveKeys(): string[] {
      return [...new Set(put.mock.calls.map(([input]) => input.key))].filter(
        (key) => store.get(key) !== undefined,
      );
    },
    /** Keys in the order they were put. */
    putKeys(): string[] {
      return put.mock.calls.map(([input]) => input.key);
    },
    /** Every recorded queue send without its transaction handle. */
    sends() {
      return sent.map(({ queue: name, name: job, payload, options: o }) => ({
        queue: name,
        name: job,
        payload,
        delaySeconds: o.delaySeconds,
        inTransaction: o.trx !== null && o.trx.isTransaction,
      }));
    },
    /** Every place the extraction code must never be: the row, audits, logs, inbox, queue. */
    async secretsOf(copyId: string, userId: string): Promise<string> {
      return [
        text(await copyRow(db, copyId)),
        text(await auditsOf(db, appId, copyId)),
        lines.join('\n'),
        text(await inboxOf(db, appId, userId)),
        text(await notifyLogsOf(db, appId, userId)),
        text(sent.map(({ queue: name, name: job, payload }) => [name, job, payload])),
      ].join('\n');
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

// ---- assembly --------------------------------------------------------------------------------------

export interface NestContext {
  get(token: unknown): unknown;
  close(): Promise<void>;
}

/**
 * A Nest application context holding `module` plus `providers` (the platform tokens the module's
 * factories and app.module's option factories may inject), made global.
 */
export async function nestContext(
  module: unknown,
  providers: readonly { readonly provide: unknown; readonly useValue: unknown }[],
): Promise<NestContext> {
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(module: unknown, options: object): Promise<NestContext>;
    };
  };
  class Dependencies {}
  class Harness {}
  return NestFactory.createApplicationContext(
    {
      module: Harness,
      imports: [
        {
          module: Dependencies,
          global: true,
          providers: [...providers],
          exports: providers.map((value) => value.provide),
        },
        module,
      ],
    },
    { logger: false, abortOnError: false },
  );
}

/** Lines of level warn and above. */
export function warnings(f: Pick<Fixture, 'lines'>): Record<string, unknown>[] {
  return f.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => typeof line['level'] === 'number' && line['level'] >= 40);
}
