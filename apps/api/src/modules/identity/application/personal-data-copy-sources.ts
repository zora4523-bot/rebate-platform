// identity's share of the personal information copy (规划/08 BR-ID-40 细则「导出范围（默认）」, BR-ID-33;
// task B1-27f; the port and its rules: ../ports/personal-data-copy-sources.ts).
// createPersonalDataCopySources(options) — the whole PersonalDataCopySources:
//   - account / realname / consents are identity's own reads (users, user_oauth, realname,
//     consent_records), decrypted in memory with options.crypto (users.phone, realname.name,
//     realname.id_no contexts) and masked here with ../domain/mask-*.ts and platform/masking's
//     rules before they leave; the phone is the only value given in full;
//   - orders / ledger / withdrawals / agent / invite are the owners' reads in options, handed
//     through unchanged: the same handle and subject in, their result out as it is.
// Reads only, on the caller's handle; no writes, no logging.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';
import { maskName } from '../domain/mask-name.ts';
import { PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';
import { REALNAME_CONTEXT } from '../infra/realname-reader.ts';
import type {
  PersonalDataCopyAccount,
  PersonalDataCopyConsent,
  PersonalDataCopyRealname,
  PersonalDataCopySources,
  PersonalDataCopySubject,
} from '../ports/personal-data-copy-sources.ts';

/** The five sections the owning modules read (assembled by app.module). */
export type PersonalDataCopyOwnerReads = Pick<
  PersonalDataCopySources,
  'orders' | 'ledger' | 'withdrawals' | 'agent' | 'invite'
>;

export interface PersonalDataCopySourcesOptions extends PersonalDataCopyOwnerReads {
  readonly crypto: Pick<FieldCrypto, 'decrypt'>;
}

/**
 * BR-ID-33 身份证: the first 1 + one "*" per hidden character + the last 1 (1****************X),
 * the same rule as platform/masking's maskIdNo (not on the platform barrel); anything that is not
 * an 18- or 15-character ID number is one "*" per code point.
 */
function maskIdNo(idNo: string): string {
  const valid =
    (idNo.length === 18 && /^[0-9]{17}[0-9Xx]$/.test(idNo)) ||
    (idNo.length === 15 && /^[0-9]{15}$/.test(idNo));
  return valid
    ? `${idNo.charAt(0)}${'*'.repeat(idNo.length - 2)}${idNo.slice(-1)}`
    : '*'.repeat([...idNo].length);
}

const REALNAME_STATUSES: ReadonlySet<string> = new Set(['none', 'verified', 'failed']);

const NO_REALNAME: PersonalDataCopyRealname = Object.freeze({
  status: 'none',
  masked_name: null,
  masked_id_no: null,
  verified_at: null,
});

function cipherText(cipher: Uint8Array): string {
  return Buffer.from(cipher).toString('utf8');
}

export function createPersonalDataCopySources(
  options: PersonalDataCopySourcesOptions,
): PersonalDataCopySources {
  const { crypto } = options;

  async function account(
    handle: Kysely<DB>,
    subject: PersonalDataCopySubject,
  ): Promise<PersonalDataCopyAccount | null> {
    const app = handle.withSchema('app');
    const user = await app
      .selectFrom('users')
      .select(['nickname', 'phone_cipher', 'created_at'])
      .where('app_id', '=', subject.appId)
      .where('id', '=', subject.userId)
      .executeTakeFirst();
    if (user === undefined) return null;
    // 第三方登录方式: the user's current bindings (a revoked one is no longer a way to log in).
    const bindings = await app
      .selectFrom('user_oauth')
      .select('provider')
      .distinct()
      .where('app_id', '=', subject.appId)
      .where('user_id', '=', subject.userId)
      .where('revoked_at', 'is', null)
      .orderBy('provider')
      .execute();
    return {
      nickname: user.nickname,
      phone:
        user.phone_cipher === null
          ? null
          : crypto.decrypt(cipherText(user.phone_cipher), PHONE_CIPHER_CONTEXT),
      login_providers: bindings.map((row) => row.provider),
      registered_at: user.created_at,
    };
  }

  async function realname(
    handle: Kysely<DB>,
    subject: PersonalDataCopySubject,
  ): Promise<PersonalDataCopyRealname> {
    const row = await handle
      .withSchema('app')
      .selectFrom('realname')
      .select(['status', 'name_cipher', 'id_no_cipher', 'verified_at'])
      .where('app_id', '=', subject.appId)
      .where('user_id', '=', subject.userId)
      .executeTakeFirst();
    if (row === undefined) return { ...NO_REALNAME };
    // The column has a CHECK; anything else is a broken database, never "not verified".
    if (!REALNAME_STATUSES.has(row.status)) throw new Error('identity: unknown realname status');
    const status = row.status as PersonalDataCopyRealname['status'];
    if (status !== 'verified') return { ...NO_REALNAME, status };
    // realname_verified_check guarantees these on a verified row.
    if (row.name_cipher === null || row.id_no_cipher === null || row.verified_at === null) {
      throw new Error('identity: incomplete verified realname record');
    }
    // The cleartext lives only long enough to be masked (BR-ID-33).
    return {
      status,
      masked_name: maskName(crypto.decrypt(cipherText(row.name_cipher), REALNAME_CONTEXT.name)),
      masked_id_no: maskIdNo(crypto.decrypt(cipherText(row.id_no_cipher), REALNAME_CONTEXT.idNo)),
      verified_at: row.verified_at,
    };
  }

  async function consents(
    handle: Kysely<DB>,
    subject: PersonalDataCopySubject,
  ): Promise<readonly PersonalDataCopyConsent[]> {
    // Only the user's own records: a device-subject record belongs to the installation.
    return handle
      .withSchema('app')
      .selectFrom('consent_records')
      .select(['type', 'version', 'channel', 'accepted', 'client_at', 'server_at'])
      .where('app_id', '=', subject.appId)
      .where('subject_type', '=', 'user')
      .where('user_id', '=', subject.userId)
      .orderBy('server_at')
      .orderBy('id')
      .execute();
  }

  const sources: PersonalDataCopySources = {
    account,
    realname,
    consents,
    orders: (handle, subject) => options.orders(handle, subject),
    ledger: (handle, subject) => options.ledger(handle, subject),
    withdrawals: (handle, subject) => options.withdrawals(handle, subject),
    agent: (handle, subject) => options.agent(handle, subject),
    invite: (handle, subject) => options.invite(handle, subject),
  };
  return Object.freeze(sources);
}
