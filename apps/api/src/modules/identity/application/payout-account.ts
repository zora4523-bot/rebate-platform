// 收款账号 (规划/08 BR-WDR-02, BR-WDR-01, BR-ID-31, BR-ID-33; 04 §6.1; task B1-13e §9.2).
//
// createPayoutAccountReader — GET /v1/me/payout-account: the current row (is_current) of the user
// in the app, masked (BR-ID-33 细则「收款账号的脱敏格式」), plus change_remaining_this_month =
// max(0, monthly limit − rows of payout_account_changes of this user and app whose changed_at lies
// in the +08:00 natural month of the injected Clock). No current row → {} (EmptyData). The
// decrypted logon id or card number lives only in memory long enough to be masked.
//
// createPayoutAccountService().save — the Alipay binding / change, run by B1-13f's PUT controller
// inside its idempotency / withStepUp transaction (this service neither reads nor settles the
// step_up_token: any refusal here makes the caller release it, BR-WDR-01). Order:
//   before the lock (no row written, no lock taken): withdraw.payout_methods without alipay →
//   20001 fields=[payout_method]; logon id normalisation (domain/alipay-logon.ts) → 20001
//   fields=[alipay_logon_id] (reason phone_invalid for the phone form);
//   users row lock, then inside it, each read fresh: ⓪ the alipay blocklist (risk) → 44001;
//   no verified realname → 30304; ① normalised payee name ≠ normalised realname name → 30307;
//   ② the alipay_hmac is another member's current binding in the app → 30308; the current binding
//   and this month's change rows; the same account (payout_method + HMAC) → 0 with the current
//   binding, nothing written, not counted; ④ a change with this month's rows ≥ the limit → 30303
//   data.reason=payout_account_change_limit; otherwise (a savepoint around the writes) the old
//   current row is set is_current=false (row_version CAS) and a payout_account_changes row is
//   appended (a first binding writes none), then the new current row is inserted. A unique
//   violation of payout_accounts_current_alipay_key (a concurrent binding the occupancy read could
//   not see) rolls back to the savepoint and answers 30308, leaving the caller's transaction
//   usable. Nothing is deleted; payout_account_changes is append-only.
//
// The user lock is `SELECT … FROM users … FOR NO KEY UPDATE`: it conflicts with every FOR UPDATE /
// FOR NO KEY UPDATE holder of the row (the other payout saves, BR-WDR-07 ① withdrawal creation,
// the verification reservation), so the saves of one user are serialised and the monthly limit
// cannot be overrun (BR-WDR-02 细则「保存在用户级锁内」). FOR UPDATE itself would deadlock: a
// blocklist hit is recorded by risk in an independent short transaction whose risk_hits row
// references users, and that foreign-key check takes FOR KEY SHARE on this very row, which FOR
// UPDATE blocks while this transaction waits for the record (login-completion.ts precedent).
// No balance row and no advisory lock are taken. Callers must not hold FOR UPDATE on the users row
// before calling save, for the same reason.
//
// Configuration (orchestrator ruling E40): withdraw.payout_methods (a non-empty set drawn from
// alipay / bank_card / wechat, default [alipay, bank_card]) and
// withdraw.payout_account_change_per_month (a whole number ≥ 0, default 2), read through the
// injected PayoutAccountConfigPort on the caller's handle (app.module binds content's reader to it,
// B1-11d precedent: no second pooled connection while the transaction is held); a missing or
// malformed value takes the default with a pino warning that carries only config_key.
// TODO(规划/11 §2.3): drop the direct config_items read used when no port is injected — blocked on
// the B1-13e rule tests, which build the service without a config port and still expect
// withdraw.payout_methods / the monthly limit to be honoured (AC-B1-13e#13, #31).
//
// Cipher AAD and blind-index context of the logon id: payout_accounts.alipay (the card number:
// payout_accounts.bank_card), the contexts risk's blocklist hashes with (blocklistHmacContexts),
// so blocklist entries and the partial unique index see the same digest. payee_name stores the
// normalised name. No plaintext, cipher text or HMAC is logged or returned.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { chinaMonth, chinaMonthRange, normalizePersonName } from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newUuidV7, type Clock, type FieldCrypto, type RootLogger } from '../../platform/index.ts';
import { blocklistHmacContexts, type BlocklistService } from '../../risk/index.ts';
import { normalizeAlipayLogonId } from '../domain/alipay-logon.ts';
import {
  maskAlipayLogonId,
  maskBankCardTail,
  maskPayeeName,
} from '../domain/mask-payout-account.ts';
import { PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';
import { createRealnameReader } from '../infra/realname-reader.ts';

export interface PayoutAccountSubject {
  readonly appId: string;
  readonly userId: string;
}

/** Trusted identity is supplied by the caller, never taken from the HTTP body. */
export interface SaveAlipayCommand extends PayoutAccountSubject {
  readonly alipayLogonId: string;
  readonly payeeName: string;
}

export type SaveAlipayResult =
  | { readonly code: 0; readonly data: components['schemas']['PayoutAccountAlipay'] }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly string[]; readonly reason?: 'phone_invalid' };
    }
  | { readonly code: 30304 | 30307 | 30308 }
  | { readonly code: 30303; readonly data: { readonly reason: 'payout_account_change_limit' } }
  | { readonly code: 44001; readonly data: { readonly risk_msg_code: string } };

/** Business configuration of one app, read on the caller's handle (content's reader). */
export interface PayoutAccountConfigPort {
  configValue(
    appId: string,
    key: string,
    handle: Kysely<DB>,
  ): Promise<{ readonly value: unknown } | null>;
}

export interface PayoutAccountServiceOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
  readonly blocklist: Pick<BlocklistService, 'check'>;
  readonly config?: PayoutAccountConfigPort;
}

export interface PayoutAccountService {
  /**
   * B1-13e: use this exact caller transaction; users FOR UPDATE before mutable reads.
   * Refusals leave payout rows unchanged. No step-up or idempotency settlement here:
   * B1-13f calls save inside its existing idempotency / withStepUp transaction.
   * Cipher AAD is payout_accounts.alipay (bank read: payout_accounts.bank_card),
   * also the blind-index domain shared with risk. Never return plaintext or HMAC.
   * (The row lock is taken FOR NO KEY UPDATE; see the file header.)
   */
  save(trx: Transaction<DB>, command: SaveAlipayCommand): Promise<SaveAlipayResult>;
}

/** GET /v1/me/payout-account data: the masked current account, or {} when nothing is bound. */
export type PayoutAccountView =
  components['schemas']['PayoutAccount'] | components['schemas']['EmptyData'];

export interface PayoutAccountReaderOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
  readonly config?: PayoutAccountConfigPort;
}

export interface PayoutAccountReader {
  read(subject: PayoutAccountSubject): Promise<PayoutAccountView>;
}

const PAYOUT_METHODS_KEY = 'withdraw.payout_methods';
const CHANGE_LIMIT_KEY = 'withdraw.payout_account_change_per_month';
/** BR-WDR-02 defaults (D12; ④). */
const DEFAULT_PAYOUT_METHODS: ReadonlySet<string> = new Set(['alipay', 'bank_card']);
const DEFAULT_CHANGE_LIMIT = 2;
const KNOWN_PAYOUT_METHODS: ReadonlySet<string> = new Set(['alipay', 'bank_card', 'wechat']);

const ALIPAY_CONTEXT = blocklistHmacContexts().alipay;
const BANK_CARD_CONTEXT = blocklistHmacContexts().bank_card;
const CURRENT_ALIPAY_KEY = 'payout_accounts_current_alipay_key';
const SAVEPOINT = sql.raw('identity_payout_account_save');

interface CurrentAccount {
  readonly id: string;
  readonly payout_method: string;
  readonly alipay_hmac: string | null;
  readonly alipay_logon_id_cipher: Buffer | null;
  readonly bank_card_hmac: string | null;
  readonly bank_card_no_cipher: Buffer | null;
  readonly bank_name: string | null;
  readonly payee_name: string;
  readonly row_version: number;
}

type Config = ReadonlyMap<string, unknown>;

async function readConfig(
  handle: Kysely<DB>,
  appId: string,
  keys: readonly string[],
  port: PayoutAccountConfigPort | undefined,
): Promise<Config> {
  if (port !== undefined) {
    const values = new Map<string, unknown>();
    for (const key of keys) {
      const entry = await port.configValue(appId, key, handle);
      if (entry !== null) values.set(key, entry.value);
    }
    return values;
  }
  const rows = await handle
    .withSchema('app')
    .selectFrom('config_items')
    .select(['key', 'value'])
    .where('app_id', '=', appId)
    .where('key', 'in', keys)
    .execute();
  return new Map<string, unknown>(rows.map((row) => [row.key, row.value]));
}

/** withdraw.payout_methods: a non-empty array of distinct known methods, else the default. */
function payoutMethods(config: Config, logger: RootLogger): ReadonlySet<string> {
  const value = config.get(PAYOUT_METHODS_KEY);
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && KNOWN_PAYOUT_METHODS.has(entry)) &&
    new Set(value).size === value.length
  ) {
    return new Set(value as string[]);
  }
  logger.warn({ config_key: PAYOUT_METHODS_KEY }, 'payout_account_config_default');
  return DEFAULT_PAYOUT_METHODS;
}

/** withdraw.payout_account_change_per_month: a whole number ≥ 0, else the default. */
function changeLimit(config: Config, logger: RootLogger): number {
  const value = config.get(CHANGE_LIMIT_KEY);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  logger.warn({ config_key: CHANGE_LIMIT_KEY }, 'payout_account_config_default');
  return DEFAULT_CHANGE_LIMIT;
}

async function currentAccount(
  handle: Kysely<DB>,
  subject: PayoutAccountSubject,
): Promise<CurrentAccount | undefined> {
  return handle
    .withSchema('app')
    .selectFrom('payout_accounts')
    .select([
      'id',
      'payout_method',
      'alipay_hmac',
      'alipay_logon_id_cipher',
      'bank_card_hmac',
      'bank_card_no_cipher',
      'bank_name',
      'payee_name',
      'row_version',
    ])
    .where('app_id', '=', subject.appId)
    .where('user_id', '=', subject.userId)
    .where('is_current', '=', true)
    .executeTakeFirst();
}

/** Rows of payout_account_changes of the subject in the +08:00 natural month of `now`. */
async function changesThisMonth(
  handle: Kysely<DB>,
  subject: PayoutAccountSubject,
  now: Date,
): Promise<number> {
  const month = chinaMonthRange(chinaMonth(now));
  const row = await handle
    .withSchema('app')
    .selectFrom('payout_account_changes')
    .select((eb) => eb.fn.countAll<string | number | bigint>().as('n'))
    .where('app_id', '=', subject.appId)
    .where('user_id', '=', subject.userId)
    .where('changed_at', '>=', sql<Date>`${month.start}::timestamptz`)
    .where('changed_at', '<', sql<Date>`${month.end}::timestamptz`)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

function remaining(limit: number, used: number): number {
  return Math.max(0, limit - used);
}

function cipherText(cipher: Buffer | null): string {
  // payout_accounts_details_check guarantees the cipher of the row's own method.
  if (cipher === null) throw new Error('identity: payout account row without its cipher');
  return Buffer.from(cipher).toString('utf8');
}

/** The masked projection of a stored alipay row. */
function projectAlipay(
  row: CurrentAccount,
  crypto: FieldCrypto,
  changeRemaining: number,
): components['schemas']['PayoutAccountAlipay'] {
  const logon = crypto.decrypt(cipherText(row.alipay_logon_id_cipher), ALIPAY_CONTEXT);
  return {
    payout_method: 'alipay',
    masked_account: maskAlipayLogonId(logon),
    masked_payee_name: maskPayeeName(row.payee_name),
    change_remaining_this_month: changeRemaining,
  };
}

/** The masked projection of a stored row (GET and the same-account answer). */
function project(
  row: CurrentAccount,
  crypto: FieldCrypto,
  changeRemaining: number,
): components['schemas']['PayoutAccount'] {
  if (row.payout_method === 'alipay') return projectAlipay(row, crypto, changeRemaining);
  if (row.payout_method === 'bank_card') {
    const cardNo = crypto.decrypt(cipherText(row.bank_card_no_cipher), BANK_CARD_CONTEXT);
    if (row.bank_name === null) throw new Error('identity: bank card row without bank_name');
    return {
      payout_method: 'bank_card',
      masked_account: maskBankCardTail(cardNo),
      bank_name: row.bank_name,
      masked_payee_name: maskPayeeName(row.payee_name),
      change_remaining_this_month: changeRemaining,
    };
  }
  throw new Error('identity: unknown payout_method on the current payout account');
}

/** The HMAC that identifies a stored account (alipay_hmac or bank_card_hmac). */
function accountHmac(row: CurrentAccount): string {
  const hmac = row.payout_method === 'alipay' ? row.alipay_hmac : row.bank_card_hmac;
  if (hmac === null) throw new Error('identity: payout account row without its HMAC');
  return hmac;
}

function isUniqueViolationOf(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

export function createPayoutAccountReader(
  options: PayoutAccountReaderOptions,
): PayoutAccountReader {
  const { db, clock, crypto, logger, config } = options;
  return Object.freeze({
    async read(subject: PayoutAccountSubject): Promise<PayoutAccountView> {
      const current = await currentAccount(db, subject);
      if (current === undefined) return {};
      const limit = changeLimit(
        await readConfig(db, subject.appId, [CHANGE_LIMIT_KEY], config),
        logger,
      );
      const used = await changesThisMonth(db, subject, clock.now());
      return project(current, crypto, remaining(limit, used));
    },
  });
}

export function createPayoutAccountService(
  options: PayoutAccountServiceOptions,
): PayoutAccountService {
  const { clock, crypto, logger, blocklist, config: configPort } = options;
  const realname = createRealnameReader(crypto);
  return Object.freeze({
    async save(
      transaction: Transaction<DB>,
      command: SaveAlipayCommand,
    ): Promise<SaveAlipayResult> {
      const trx = transaction.withSchema('app');
      const subject: PayoutAccountSubject = { appId: command.appId, userId: command.userId };

      // Local checks before the lock: they read no user state and write nothing.
      const config = await readConfig(
        trx,
        subject.appId,
        [PAYOUT_METHODS_KEY, CHANGE_LIMIT_KEY],
        configPort,
      );
      const methods = payoutMethods(config, logger);
      const limit = changeLimit(config, logger);
      if (!methods.has('alipay')) return { code: 20001, data: { fields: ['payout_method'] } };
      const normalized = normalizeAlipayLogonId(command.alipayLogonId);
      if (normalized.code !== 0) return { code: 20001, data: normalized.data };
      const logon = normalized.logon;
      const alipayHmac = crypto.blindIndex(logon, ALIPAY_CONTEXT);
      const payeeName = normalizePersonName(command.payeeName);

      // The user lock (see the file header for FOR NO KEY UPDATE); everything after is reread.
      const user = await trx
        .selectFrom('users')
        .select('phone_cipher')
        .where('app_id', '=', subject.appId)
        .where('id', '=', subject.userId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (user === undefined) throw new Error('identity: payout account save for an unknown user');

      // ⓪ BR-ID-31: checked after the lock, so an entry registered while waiting still hits.
      const hit = await blocklist.check({
        app_id: subject.appId,
        dimension: 'alipay',
        value_hmac: alipayHmac,
        request_type: 'payout_account',
        user_id: subject.userId,
        // The blocked request's related phone (risk stores only its HMAC and masked form).
        related_phone:
          user.phone_cipher === null
            ? ''
            : crypto.decrypt(Buffer.from(user.phone_cipher).toString('utf8'), PHONE_CIPHER_CONTEXT),
      });
      if (hit !== null) return { code: 44001, data: { risk_msg_code: hit.data.risk_msg_code } };

      // ① the payee name against the verified real name, both normalised.
      const verified = await realname.verified(trx, {
        app_id: subject.appId,
        user_id: subject.userId,
      });
      if (verified === null) return { code: 30304 };
      if (normalizePersonName(verified.name) !== payeeName) return { code: 30307 };

      // ② another member's current binding of the same account in this app.
      const occupied = await trx
        .selectFrom('payout_accounts')
        .select('id')
        .where('app_id', '=', subject.appId)
        .where('alipay_hmac', '=', alipayHmac)
        .where('is_current', '=', true)
        .where('user_id', '<>', subject.userId)
        .executeTakeFirst();
      if (occupied !== undefined) return { code: 30308 };

      const now = clock.now();
      const current = await currentAccount(trx, subject);
      const used = await changesThisMonth(trx, subject, now);
      if (
        current !== undefined &&
        current.payout_method === 'alipay' &&
        current.alipay_hmac === alipayHmac
      ) {
        // The same account: nothing written, not counted, never over the limit.
        return { code: 0, data: projectAlipay(current, crypto, remaining(limit, used)) };
      }
      // ④ only a change of an existing binding counts; a first binding does not.
      if (current !== undefined && used >= limit) {
        return { code: 30303, data: { reason: 'payout_account_change_limit' } };
      }

      await sql`SAVEPOINT ${SAVEPOINT}`.execute(trx);
      try {
        if (current !== undefined) {
          const retired = await trx
            .updateTable('payout_accounts')
            .set({ is_current: false, row_version: current.row_version + 1, updated_at: now })
            .where('app_id', '=', subject.appId)
            .where('id', '=', current.id)
            .where('is_current', '=', true)
            .where('row_version', '=', current.row_version)
            .executeTakeFirst();
          // Under the user lock nobody else writes this user's accounts.
          if (retired.numUpdatedRows !== 1n) {
            throw new Error('identity: current payout account changed under the user lock');
          }
          await trx
            .insertInto('payout_account_changes')
            .values({
              app_id: subject.appId,
              user_id: subject.userId,
              old_payout_method: current.payout_method,
              old_hmac: accountHmac(current),
              new_payout_method: 'alipay',
              new_hmac: alipayHmac,
              operator: `user:${subject.userId}`,
              changed_at: now,
              created_at: now,
            })
            .execute();
        }
        await trx
          .insertInto('payout_accounts')
          .values({
            id: newUuidV7(now),
            app_id: subject.appId,
            user_id: subject.userId,
            payout_method: 'alipay',
            alipay_logon_id_cipher: Buffer.from(crypto.encrypt(logon, ALIPAY_CONTEXT), 'utf8'),
            alipay_hmac: alipayHmac,
            bank_card_no_cipher: null,
            bank_card_hmac: null,
            bank_name: null,
            card_bin: null,
            payee_name: payeeName,
            is_current: true,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await sql`RELEASE SAVEPOINT ${SAVEPOINT}`.execute(trx);
      } catch (error) {
        if (!isUniqueViolationOf(error, CURRENT_ALIPAY_KEY)) throw error;
        // A concurrent binding of the same account won the partial unique index after ②.
        await sql`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`.execute(trx);
        await sql`RELEASE SAVEPOINT ${SAVEPOINT}`.execute(trx);
        return { code: 30308 };
      }

      return {
        code: 0,
        data: {
          payout_method: 'alipay',
          masked_account: maskAlipayLogonId(logon),
          masked_payee_name: maskPayeeName(payeeName),
          change_remaining_this_month: remaining(limit, used + (current === undefined ? 0 : 1)),
        },
      };
    },
  });
}
