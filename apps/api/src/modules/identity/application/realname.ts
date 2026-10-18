// POST /v1/me/realname (submitRealname; 规划/08 BR-ID-25, BR-ID-26; task B1-13d §9.2): two-element
// real-name verification of the token's user. identity is the only writer of app.realname.
//
// Order after the stages the request passed (④ idempotency replay, ④a version gate, ⑧ 10005 phone
// in the idempotency post-miss check), first hit wins (§9.2 #1):
//   1. 10004 data.consent_type=id_verification — the user-level current id_verification record
//      (latest server_at, then largest id; device records and other types never count) is missing
//      or not accepted. The version is not compared (E28).
//   2. already verified (E26) → 0 with the stored masked name; nothing is checked, counted or
//      written, the submitted values are ignored.
//   3. 20001 data.fields — the name is empty after normalizePersonName, and/or the ID number fails
//      parseResidentIdNo (18 characters, date, check digit; trim and trailing x → X).
//   4. 30407 — under minor.min_realname_age at the Clock instant (BR-ID-26: the birthday's next day
//      00:00 +08:00, 29 February → 1 March in common years).
//   5. 30410 — the user's attempts of the +08:00 day are used up (realname-attempts.ts: reserved
//      atomically before anything below, so concurrent requests cannot exceed the limit; one count
//      per Idempotency-Key, so a retry of the same key after a failure without a stored result is
//      not counted again). Redis unavailable → 50001 (fail closed, nothing called).
//   6. 30405 — the blind index of the normalised ID number is verified on another user of this
//      app (the occupant is never revealed). Counts one attempt (no vendor call).
//   7. vendor: none assembled or an answer that is not definite (unavailable / malformed /
//      rejection) → 50301; timeout → 50401; both release this request's reservation only (a
//      decrement, never a reset). match / mismatch keep it (one attempt).
//      mismatch → 30406 and the user's row becomes status failed without any ciphertext (E27).
//      match → the row becomes verified with name / ID number / birth date ciphertexts, the blind
//      index, provider and verified_at (Clock). A concurrent verification of the same ID number on
//      another user loses on the partial unique index (23505) → 30405, still counted.
// One row per user (realname_user_key): writes are INSERT … ON CONFLICT (app_id, user_id) that
// never touch a verified row. The name and the ID number never go into logs, errors or responses
// (only the masked name of a verified record is answered); a vendor error is never logged.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import type { DB } from '@couli/db';
import {
  accountingDate,
  isAtLeastAge,
  normalizePersonName,
  parseResidentIdNo,
} from '@couli/domain';
import { sql, type Kysely } from 'kysely';
import {
  newUuidV7,
  type Clock,
  type FieldCrypto,
  type RedisHandle,
  type RootLogger,
} from '../../platform/index.ts';
import { maskName } from '../domain/mask-name.ts';
import { createRealnameAttempts, type AttemptSlot } from './realname-attempts.ts';
import { REALNAME_CONTEXT } from '../infra/realname-reader.ts';
import type {
  RealnameVerificationResult,
  RealnameVerifierPort,
} from '../ports/realname-verifier.ts';

/**
 * BR-ID-26 配置 minor.min_realname_age (default 14).
 * TODO(规划/11 §2.3): 从配置中心读取 minor.min_realname_age — blocked on 该配置项尚未登记（内容配置注册表不在本任务路径内）
 */
export const MIN_REALNAME_AGE = 14;
/** The partial unique index (app_id, id_no_hmac) WHERE status = 'verified' of migration 0041. */
const VERIFIED_ID_NO_KEY = 'realname_verified_id_no_hmac_key';

export interface SubmitRealnameCommand {
  readonly appId: string;
  readonly userId: string;
  /** As submitted; normalised here. */
  readonly name: string;
  /** As submitted; normalised here. */
  readonly idNo: string;
  /** The request's Idempotency-Key (validated): one daily count per key (realname-attempts.ts). */
  readonly idempotencyKey: string;
}

export type SubmitRealnameResult =
  | {
      readonly code: 0;
      readonly data: { readonly realname_status: 'verified'; readonly masked_name: string };
    }
  | { readonly code: 10004; readonly data: { readonly consent_type: 'id_verification' } }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 30405 | 30406 | 30407 | 30410 | 50001 | 50301 | 50401 };

export interface RealnameServiceOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  /** Null when the process has no Redis: every counted step answers 50001. */
  readonly redis: RedisHandle | null;
  /** Null when no vendor is assembled (staging / prod for now): 50301, not counted. */
  readonly verifier: RealnameVerifierPort | null;
  readonly logger: Pick<RootLogger, 'info' | 'warn'>;
}

export interface RealnameService {
  submit(command: SubmitRealnameCommand): Promise<SubmitRealnameResult>;
}

function uniqueViolationOf(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pg = error as { code?: unknown; constraint?: unknown };
  return pg.code === '23505' && pg.constraint === constraint;
}

/** A definite vendor answer, else timeout / unavailable (malformed answers are unavailable). */
function outcomeOf(
  result: RealnameVerificationResult | undefined,
):
  | { readonly outcome: 'match' | 'mismatch'; readonly provider: string }
  | 'timeout'
  | 'unavailable' {
  if (typeof result !== 'object' || result === null) return 'unavailable';
  const { outcome, provider } = result as {
    readonly outcome?: unknown;
    readonly provider?: unknown;
  };
  if (outcome === 'timeout') return 'timeout';
  if (
    (outcome === 'match' || outcome === 'mismatch') &&
    typeof provider === 'string' &&
    /\S/.test(provider)
  ) {
    return { outcome, provider };
  }
  return 'unavailable';
}

export function createRealnameService(options: RealnameServiceOptions): RealnameService {
  const { clock, crypto, redis, verifier, logger } = options;
  // Bound per call: assemblies built without a real database (HTTP unit tests) pass a stub.
  const app = () => options.db.withSchema('app');
  const encrypt = (value: string, context: string) =>
    Buffer.from(crypto.encrypt(value, context), 'utf8');

  const verifiedAnswer = (name: string): SubmitRealnameResult => ({
    code: 0,
    data: { realname_status: 'verified', masked_name: maskName(name) },
  });

  /** The stored masked name of the user's verified record, or undefined. */
  async function storedVerified(command: SubmitRealnameCommand) {
    const row = await app()
      .selectFrom('realname')
      .select(['status', 'name_cipher'])
      .where('app_id', '=', command.appId)
      .where('user_id', '=', command.userId)
      .executeTakeFirst();
    if (row?.status !== 'verified') return undefined;
    if (row.name_cipher === null) throw new Error('identity: verified realname without a name');
    return verifiedAnswer(
      crypto.decrypt(Buffer.from(row.name_cipher).toString('utf8'), REALNAME_CONTEXT.name),
    );
  }

  async function consentAccepted(command: SubmitRealnameCommand): Promise<boolean> {
    const latest = await app()
      .selectFrom('consent_records')
      .select('accepted')
      .where('app_id', '=', command.appId)
      .where('subject_type', '=', 'user')
      .where('user_id', '=', command.userId)
      .where('type', '=', 'id_verification')
      .orderBy('server_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return latest?.accepted === true;
  }

  const attempts = redis === null ? null : createRealnameAttempts(redis);

  /** Gives this key's reservation back; a failure only logs (the count stays stricter). */
  async function release(command: SubmitRealnameCommand, slot: AttemptSlot): Promise<void> {
    if (attempts === null) return;
    try {
      await attempts.release(slot, clock.now());
    } catch {
      logger.warn(
        { app_id: command.appId, user_id: command.userId },
        'identity_realname_release_failed',
      );
    }
  }

  async function occupiedElsewhere(
    command: SubmitRealnameCommand,
    idNoHmac: string,
  ): Promise<boolean> {
    const row = await app()
      .selectFrom('realname')
      .select('id')
      .where('app_id', '=', command.appId)
      .where('id_no_hmac', '=', idNoHmac)
      .where('status', '=', 'verified')
      .where('user_id', '<>', command.userId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** E27: status failed, no ciphertext; never replaces a verified row. */
  async function writeFailed(command: SubmitRealnameCommand, provider: string): Promise<void> {
    const now = clock.now();
    await app()
      .insertInto('realname')
      .values({
        id: newUuidV7(now),
        app_id: command.appId,
        user_id: command.userId,
        status: 'failed',
        provider,
        verified_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns(['app_id', 'user_id'])
          .doUpdateSet({
            status: 'failed',
            name_cipher: null,
            id_no_cipher: null,
            id_no_hmac: null,
            birth_date_cipher: null,
            provider,
            verified_at: null,
            updated_at: now,
            row_version: sql<number>`realname.row_version + 1`,
          })
          .where(sql<boolean>`realname.status <> 'verified'`),
      )
      .execute();
  }

  /** True when this request wrote the verified row; false when the row was already verified. */
  async function writeVerified(
    command: SubmitRealnameCommand,
    values: {
      readonly name: string;
      readonly idNo: string;
      readonly idNoHmac: string;
      readonly birthDate: string;
      readonly provider: string;
    },
  ): Promise<boolean> {
    const now = clock.now();
    const verified = {
      status: 'verified',
      name_cipher: encrypt(values.name, REALNAME_CONTEXT.name),
      id_no_cipher: encrypt(values.idNo, REALNAME_CONTEXT.idNo),
      id_no_hmac: values.idNoHmac,
      birth_date_cipher: encrypt(values.birthDate, REALNAME_CONTEXT.birthDate),
      provider: values.provider,
      verified_at: now,
      updated_at: now,
    } as const;
    const written = await app()
      .insertInto('realname')
      .values({
        id: newUuidV7(now),
        app_id: command.appId,
        user_id: command.userId,
        ...verified,
        created_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns(['app_id', 'user_id'])
          .doUpdateSet({ ...verified, row_version: sql<number>`realname.row_version + 1` })
          .where(sql<boolean>`realname.status <> 'verified'`),
      )
      .returning('id')
      .executeTakeFirst();
    return written !== undefined;
  }

  return Object.freeze({
    async submit(command: SubmitRealnameCommand): Promise<SubmitRealnameResult> {
      if (!(await consentAccepted(command))) {
        return { code: 10004, data: { consent_type: 'id_verification' } };
      }
      const already = await storedVerified(command);
      if (already !== undefined) return already;

      const name = normalizePersonName(command.name);
      const parsed = parseResidentIdNo(command.idNo);
      const fields: string[] = [];
      if (name.length === 0) fields.push('name');
      if (!parsed.ok) fields.push('id_no');
      if (!parsed.ok || fields.length > 0) return { code: 20001, data: { fields } };

      const now = clock.now();
      if (!isAtLeastAge(parsed.birth_date, MIN_REALNAME_AGE, now)) return { code: 30407 };

      const slot: AttemptSlot = {
        appId: command.appId,
        userId: command.userId,
        day: accountingDate(now),
        idempotencyKey: command.idempotencyKey,
      };
      let reservation;
      try {
        if (attempts === null) throw new Error('identity: no Redis for real-name attempts');
        reservation = await attempts.reserve(slot, now);
      } catch {
        // Never the Redis error (no PII, but no need either): one flat line.
        logger.warn(
          { app_id: command.appId, user_id: command.userId },
          'identity_realname_attempts_unavailable',
        );
        return { code: 50001 };
      }
      if (reservation === 'full') return { code: 30410 };

      // From here the reservation is kept (counted) unless released. A key seen before was counted
      // by its earlier attempt (no stored result, e.g. a failed write): never given back here.
      let counted = reservation === 'seen';
      try {
        const idNoHmac = crypto.blindIndex(parsed.id_no, REALNAME_CONTEXT.idNo);
        if (await occupiedElsewhere(command, idNoHmac)) {
          counted = true;
          return { code: 30405 };
        }
        if (verifier === null) return { code: 50301 };
        let answer: RealnameVerificationResult | undefined;
        try {
          answer = await verifier.verify({
            app_id: command.appId,
            user_id: command.userId,
            name,
            id_no: parsed.id_no,
          });
        } catch {
          // The rejection may carry the submitted values: never log or rethrow it.
          answer = undefined;
        }
        const outcome = outcomeOf(answer);
        if (outcome === 'timeout' || outcome === 'unavailable') {
          logger.warn(
            { app_id: command.appId, user_id: command.userId, outcome },
            'identity_realname_vendor_failed',
          );
          return { code: outcome === 'timeout' ? 50401 : 50301 };
        }
        // A definite answer counts, whatever happens to the write below.
        counted = true;
        if (outcome.outcome === 'mismatch') {
          await writeFailed(command, outcome.provider);
          return { code: 30406 };
        }
        try {
          const wrote = await writeVerified(command, {
            name,
            idNo: parsed.id_no,
            idNoHmac,
            birthDate: parsed.birth_date,
            provider: outcome.provider,
          });
          if (!wrote) {
            // A concurrent request of this user verified first: answer the stored record.
            return (await storedVerified(command)) ?? { code: 50001 };
          }
        } catch (error) {
          if (!uniqueViolationOf(error, VERIFIED_ID_NO_KEY)) throw error;
          return { code: 30405 };
        }
        logger.info(
          { app_id: command.appId, user_id: command.userId, provider: outcome.provider },
          'identity_realname_verified',
        );
        return verifiedAnswer(name);
      } finally {
        if (!counted) await release(command, slot);
      }
    },
  });
}
