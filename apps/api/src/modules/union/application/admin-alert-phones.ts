// Admin alert phones of the station-owner authorization SMS (B1-22g; BR-ID-24 ② and 细则
// 「后台联盟账号列表」「后台告警手机号与重新授权会话」, D10-152 ④, D10-176; BR-ID-33; BR-ID-05 细则
// 「手机号规范化」; contract adminListUnionAlertPhones / adminAddUnionAlertPhone /
// adminRemoveUnionAlertPhone). The group lives encrypted in union.auth_alert_phones, read through
// content's reader and written only through content's dedicated write port (D10-281) inside
// union's transaction, together with union's audit row. union never writes config_items itself.
//
// The controller has already checked the admin_token, the permission point union.account_auth and
// (add / remove) the totp step-up; the app and the admin are the guard's actor.
//
// - list: phone_masked (3 + 4) and phone_id (B1-22b alertPhoneId, the HMAC of the normalized
//   number) of every stored number, and the item version (0 = never written).
// - add: BR-ID-05 normalization (not a mainland mobile → 20001 [phone] phone_invalid), then CAS on
//   the item version (20902 config_item), then the same number → success without a write (the
//   audit row is still appended), then at most 10 (20001 [phone]); otherwise the whole group is
//   re-encrypted and written through the port, which re-checks the version under its row lock.
// - remove: CAS, then a phone_id not in the group → 20001 [phone_id]; otherwise the group without
//   it is written the same way.
//
// The number in clear never reaches an error, an audit row, a response or a log line: audit rows
// carry the masked number and the phone_id only, refusals name fields only. Time comes only from
// the injected Clock. Pure module (no decorators, erasable syntax).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  UnionAlertPhonesConflictError,
  type ContentReader,
  type UnionAlertPhonesValue,
  type UnionAlertPhonesWriter,
} from '../../content/index.ts';
import type { Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';
import { normalizeAlertPhone } from '../auth-expiry/phone.ts';
import { alertPhoneId, decodeAlertPhones, encodeAlertPhones } from '../auth-expiry/service.ts';
import { validAdminUnionReason } from '../domain/admin-reason.ts';
import type { UnionAuditWriter } from '../pids/service.ts';

export type AdminUnionAlertPhones = Schema<'AdminUnionAlertPhones'>;
export type AdminUnionAlertPhoneAddRequest = Schema<'AdminUnionAlertPhoneAddRequest'>;

/** The signed-in admin of the request. */
export interface AdminUnionAlertPhoneActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

/** DELETE query: the phone_id of the list and the version the console showed. */
export interface AdminUnionAlertPhoneRemoval {
  readonly phoneId: string;
  readonly expectedVersion: number;
}

export interface AdminUnionAlertPhonesOptions {
  /** Absent in isolated HTTP unit tests: every call fails closed. */
  readonly db: Kysely<DB> | undefined;
  readonly clock: Clock;
  readonly crypto: FieldCrypto | undefined;
  readonly config: (db: Kysely<DB>, clock: Clock) => Pick<ContentReader, 'configValue'>;
  /** content's union.auth_alert_phones write port (createUnionAlertPhonesWriter). */
  readonly writer: Pick<UnionAlertPhonesWriter, 'write'>;
  readonly auditWriter: (db: Kysely<DB>) => UnionAuditWriter;
  readonly logger?: Pick<RootLogger, 'error'>;
}

/** Refusal mapped to 20001 with data.fields (and data.reason=phone_invalid when set). */
export class AdminUnionAlertPhonesFieldsError extends Error {
  readonly fields: readonly string[];
  readonly reason: 'phone_invalid' | null;

  constructor(fields: readonly string[], reason: 'phone_invalid' | null) {
    super(`union alert phones: invalid ${fields.join(', ')}`);
    this.name = 'AdminUnionAlertPhonesFieldsError';
    this.fields = fields;
    this.reason = reason;
  }
}

/** expected_version is not the item's current version: 20902 with data.resource=config_item. */
export class AdminUnionAlertPhonesConflictError extends Error {
  constructor() {
    super('union alert phones: version conflict');
    this.name = 'AdminUnionAlertPhonesConflictError';
  }
}

const KEY = 'union.auth_alert_phones';
/** BR-ID-24 细则: at most 10 alert phones. */
const MAX_PHONES = 10;
const ACTION_ADD = 'union_alert_phone_add';
const ACTION_REMOVE = 'union_alert_phone_remove';

interface Group {
  readonly phones: readonly string[];
  readonly version: number;
}

/** BR-ID-33 display mask of a normalized 11-digit number: the first 3 and the last 4 digits. */
function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function optionalReason(value: unknown): string | null {
  if (value === undefined) return null;
  // D10-427 ①: a Cc control character is 20001 [reason] here, not the content writer's refusal.
  if (typeof value !== 'string' || !validAdminUnionReason(value)) {
    throw new AdminUnionAlertPhonesFieldsError(['reason'], null);
  }
  return value;
}

export class AdminUnionAlertPhonesService {
  readonly #db: Kysely<DB> | undefined;
  readonly #clock: Clock;
  readonly #crypto: FieldCrypto | undefined;
  readonly #config: (db: Kysely<DB>, clock: Clock) => Pick<ContentReader, 'configValue'>;
  readonly #writer: Pick<UnionAlertPhonesWriter, 'write'>;
  readonly #auditWriter: (db: Kysely<DB>) => UnionAuditWriter;
  readonly #logger: Pick<RootLogger, 'error'> | undefined;

  constructor(options: AdminUnionAlertPhonesOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#crypto = options.crypto;
    this.#config = options.config;
    this.#writer = options.writer;
    this.#auditWriter = options.auditWriter;
    this.#logger = options.logger;
  }

  async list(actor: AdminUnionAlertPhoneActor): Promise<AdminUnionAlertPhones> {
    const group = await this.#read(this.#database(), actor.appId);
    return this.#view(group.phones, group.version);
  }

  async add(
    actor: AdminUnionAlertPhoneActor,
    body: AdminUnionAlertPhoneAddRequest,
  ): Promise<AdminUnionAlertPhones> {
    const input = body as { phone?: unknown; expected_version?: unknown; reason?: unknown };
    if (typeof input.phone !== 'string' || input.phone.length === 0) {
      throw new AdminUnionAlertPhonesFieldsError(['phone'], null);
    }
    const expectedVersion = this.#expectedVersion(input.expected_version);
    const reason = optionalReason(input.reason);
    const phone = normalizeAlertPhone(input.phone);
    if (phone === null) throw new AdminUnionAlertPhonesFieldsError(['phone'], 'phone_invalid');
    const db = this.#database();
    const crypto = this.#cipher();

    return db.transaction().execute(async (trx) => {
      const group = await this.#read(trx, actor.appId);
      if (group.version !== expectedVersion) throw new AdminUnionAlertPhonesConflictError();
      const phoneId = alertPhoneId(crypto, phone);
      let phones = group.phones;
      let version = group.version;
      if (!phones.includes(phone)) {
        if (phones.length >= MAX_PHONES) {
          throw new AdminUnionAlertPhonesFieldsError(['phone'], null);
        }
        phones = [...phones, phone];
        version = await this.#write(trx, actor, phones, expectedVersion, reason);
      }
      // The same number again: nothing written, the accepted call is still audited (contract).
      await this.#auditWriter(trx).append({
        appId: actor.appId,
        actor: actor.adminId,
        action: ACTION_ADD,
        target: phoneId,
        before: { version: group.version, count: group.phones.length },
        after: {
          version,
          count: phones.length,
          phone_id: phoneId,
          phone_masked: maskPhone(phone),
          reason,
        },
        ip: actor.ip,
      });
      return this.#view(phones, version);
    });
  }

  async remove(
    actor: AdminUnionAlertPhoneActor,
    removal: AdminUnionAlertPhoneRemoval,
  ): Promise<AdminUnionAlertPhones> {
    if (typeof removal.phoneId !== 'string' || removal.phoneId.length === 0) {
      throw new AdminUnionAlertPhonesFieldsError(['phone_id'], null);
    }
    const expectedVersion = this.#expectedVersion(removal.expectedVersion);
    const db = this.#database();
    const crypto = this.#cipher();

    return db.transaction().execute(async (trx) => {
      const group = await this.#read(trx, actor.appId);
      if (group.version !== expectedVersion) throw new AdminUnionAlertPhonesConflictError();
      const gone = group.phones.find((phone) => alertPhoneId(crypto, phone) === removal.phoneId);
      if (gone === undefined) throw new AdminUnionAlertPhonesFieldsError(['phone_id'], null);
      const phones = group.phones.filter((phone) => phone !== gone);
      const version = await this.#write(trx, actor, phones, expectedVersion, null);
      await this.#auditWriter(trx).append({
        appId: actor.appId,
        actor: actor.adminId,
        action: ACTION_REMOVE,
        target: removal.phoneId,
        before: { version: group.version, count: group.phones.length },
        after: {
          version,
          count: phones.length,
          phone_id: removal.phoneId,
          phone_masked: maskPhone(gone),
        },
        ip: actor.ip,
      });
      return this.#view(phones, version);
    });
  }

  #database(): Kysely<DB> {
    if (this.#db === undefined) throw new Error('union: alert phones need the database');
    return this.#db;
  }

  #cipher(): FieldCrypto {
    if (this.#crypto === undefined) throw new Error('union: alert phones need the field cipher');
    return this.#crypto;
  }

  #expectedVersion(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new AdminUnionAlertPhonesFieldsError(['expected_version'], null);
    }
    return value;
  }

  /** The stored group and its item version (0 and empty when the item was never written). */
  async #read(handle: Kysely<DB>, appId: string): Promise<Group> {
    // A fresh reader per call: a cached answer must never decide a CAS or show a stale list.
    const item = await this.#config(handle, this.#clock).configValue(appId, KEY);
    if (item === null) return { phones: [], version: 0 };
    const crypto = this.#cipher();
    try {
      return { phones: decodeAlertPhones(crypto, item.value), version: item.version };
    } catch (error) {
      this.#logger?.error(
        { app_id: appId, key: KEY, error_name: errorName(error) },
        'union_auth_alert_phones_unreadable',
      );
      throw new Error('union: union.auth_alert_phones cannot be read');
    }
  }

  /** Writes the re-encrypted group through content's port; its CAS loser is a 20902. */
  async #write(
    trx: Transaction<DB>,
    actor: AdminUnionAlertPhoneActor,
    phones: readonly string[],
    expectedVersion: number,
    reason: string | null,
  ): Promise<number> {
    const value = encodeAlertPhones(this.#cipher(), phones) as UnionAlertPhonesValue;
    try {
      const written = await this.#writer.write(trx, {
        appId: actor.appId,
        value,
        expectedVersion,
        adminId: actor.adminId,
        reason,
      });
      return written.version;
    } catch (error) {
      if (error instanceof UnionAlertPhonesConflictError) {
        throw new AdminUnionAlertPhonesConflictError();
      }
      // UnionAlertPhonesInputError (or a database failure): an internal error, nothing written.
      throw error;
    }
  }

  #view(phones: readonly string[], version: number): AdminUnionAlertPhones {
    const crypto = this.#cipher();
    return {
      version,
      items: phones.map((phone) => ({
        phone_id: alertPhoneId(crypto, phone),
        phone_masked: maskPhone(phone),
      })),
    };
  }
}
