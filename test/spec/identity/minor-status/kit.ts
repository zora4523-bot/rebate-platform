// Shared fixtures of the B1-03zc rule tests (规划/08 BR-ID-25, BR-ID-26; task §9.2, §9.3).
// Synthetic rows only. Nothing here calls the code under test, and no expected instant is computed
// with @couli/domain: every boundary in the tests is written by hand in UTC (+08:00 minus 8 hours).
// @couli/db/testing is imported only by the *.int.test.ts files, never by this kit.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { CompiledQuery, Kysely, KyselyPlugin } from 'kysely';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
  type FieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';

/** FieldCrypto domains of the realname columns, copied from the writer (not imported). */
export const CONTEXT = {
  name: 'realname.name',
  idNo: 'realname.id_no',
  birthDate: 'realname.birth_date',
} as const;

/** Default instant of a check: 2026-10-30 12:00 +08:00. */
export const AT = new Date('2026-10-30T04:00:00.000Z');
/** Default identification instant, well before AT. */
export const VERIFIED = new Date('2026-01-01T00:00:00.000Z');
/** 16 at AT. */
export const MINOR_BIRTH = '2010-05-15';
/** 30 at AT. */
export const ADULT_BIRTH = '1996-05-15';
const ROW_TIME = new Date('2025-01-01T00:00:00.000Z');

export async function openCrypto(): Promise<FieldCrypto> {
  const provider = new LocalKeyProvider(randomBytes(32));
  return openFieldCrypto(await createWrappedKeyring(provider), provider);
}

/**
 * A FieldCrypto that forwards to `inner` and records the context of every decrypt call (the
 * reader may only decrypt the birth date, never the name or the ID number).
 */
export function watchDecrypt(inner: FieldCrypto): { crypto: FieldCrypto; contexts: string[] } {
  const contexts: string[] = [];
  const crypto: FieldCrypto = Object.freeze({
    currentKeyVersion: inner.currentKeyVersion,
    encrypt: (plaintext: string, context: string) => inner.encrypt(plaintext, context),
    decrypt: (ciphertext: string, context: string) => {
      contexts.push(context);
      return inner.decrypt(ciphertext, context);
    },
    keyVersionOf: (ciphertext: string) => inner.keyVersionOf(ciphertext),
    needsReencrypt: (ciphertext: string) => inner.needsReencrypt(ciphertext),
    reencrypt: (ciphertext: string, context: string) => inner.reencrypt(ciphertext, context),
    blindIndex: (value: string, context: string) => inner.blindIndex(value, context),
  });
  return { crypto, contexts };
}

export async function user(executor: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await executor
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'synthetic-minor-status',
      avatar: 'https://example.invalid/avatar.png',
      phone_hmac: `synthetic_${id}`,
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'sms',
      created_at: ROW_TIME,
      updated_at: ROW_TIME,
    })
    .execute();
  return id;
}

export interface RealnameSeed {
  readonly status?: 'none' | 'verified' | 'failed';
  /** Plain birth date, encrypted under CONTEXT.birthDate unless `birthCipher` is given. */
  readonly birth?: string;
  /** Raw bytes stored in birth_date_cipher instead (broken-database fixtures). */
  readonly birthCipher?: Buffer;
  readonly verifiedAt?: Date | null;
  /** status 'none' with tax_retained keeps the ciphers (realname_unverified_cleared_check). */
  readonly taxRetained?: boolean;
}

/** One app.realname row; verified (and tax-retained none) rows carry every cipher. */
export async function realname(
  executor: Kysely<DB>,
  crypto: FieldCrypto,
  appId: string,
  userId: string,
  seed: RealnameSeed = {},
): Promise<void> {
  const status = seed.status ?? 'verified';
  const keepsCiphers = status === 'verified' || seed.taxRetained === true;
  const encrypted = (value: string, context: string) => Buffer.from(crypto.encrypt(value, context));
  const verifiedAt =
    seed.verifiedAt === undefined ? (keepsCiphers ? VERIFIED : null) : seed.verifiedAt;
  await executor
    .withSchema('app')
    .insertInto('realname')
    .values({
      id: randomUUID(),
      app_id: appId,
      user_id: userId,
      status,
      tax_retained: seed.taxRetained ?? false,
      ...(keepsCiphers
        ? {
            name_cipher: encrypted('合成姓名', CONTEXT.name),
            id_no_cipher: encrypted(`synthetic-id-${userId}`, CONTEXT.idNo),
            id_no_hmac: randomBytes(32).toString('hex'),
            birth_date_cipher:
              seed.birthCipher ?? encrypted(seed.birth ?? MINOR_BIRTH, CONTEXT.birthDate),
            provider: 'synthetic',
          }
        : {}),
      verified_at: verifiedAt,
      created_at: ROW_TIME,
      updated_at: ROW_TIME,
    })
    .execute();
}

/** A user of `appId` with a realname row; returns the user id. */
export async function person(
  executor: Kysely<DB>,
  crypto: FieldCrypto,
  appId: string,
  seed: RealnameSeed | null = {},
): Promise<string> {
  const id = await user(executor, appId);
  if (seed !== null) await realname(executor, crypto, appId, id, seed);
  return id;
}

/** The executor with a plugin that records every statement compiled through it. */
export function observe(executor: Kysely<DB>) {
  const statements: CompiledQuery[] = [];
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      statements.push(executor.getExecutor().compileQuery(node, queryId));
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  return { executor: executor.withPlugin(plugin), statements };
}

export function normalized(query: CompiledQuery): string {
  return query.sql.replaceAll('"', '').replace(/\s+/g, ' ').trim().toLowerCase();
}
