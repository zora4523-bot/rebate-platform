// Labor agreement (规划/08 BR-WDR-31, BR-ID-12, BR-ID-33; contract getLaborAgreement /
// signLaborAgreement; task B1-13h §9.2). Native App only: h5_token is refused before this
// (the H5 exclusion prefix list in the access token checks), not-realname by stage ⑨ (B1-02za).
//
// read (GET /v1/me/labor-agreement): the configured current version, text_url and text_sha256, and
// the user's signing state (domain/labor-agreement.ts signingState). Writes nothing; the same
// configuration faults (and a missing reader) answer 50001 as for the signature.
//
// sign (POST /v1/me/labor-agreement/sign), in the transaction of the idempotency claim:
//   1. the users row lock, then the user's consent lock (lock order of consents.ts: users row →
//      consent lock), so one user's consent writes follow each other and the latest server_at is
//      the last record written;
//   2. configuration (through the assembled LaborAgreementConfigReader on the transaction, read as
//      one committed state by consistentConfigValues; identity never reads config_items itself): agreement metadata and the operating entity; a missing or
//      malformed key → 50001 and one warn carrying only config_key (no user, device or record id),
//      nothing written; no reader assembled → 50001 and one warn as well;
//   3. version / text_sha256 / agreed against the current configuration → 20001 data.fields listing
//      every mismatch (E20), nothing written;
//   4. the verified real-name record (the signer); none → 30304 (stage ⑨ normally answers first);
//   5. one Clock read, then one inserted consent_records row: subject_type=user, the token's user,
//      the request's verified device, type=labor_agreement, version, accepted=true,
//      channel=withdraw_flow, text_sha256, signer_snapshot {platform {name, credit_code}, user
//      {user_id, realname_id, masked_name}} (read at signing time, never updated afterwards),
//      client_at = server_at = created_at = that instant (the request carries no client time, E30).
//   Every signature inserts a new row, also for a version already signed; earlier rows are never
//   touched. The full name and the ID number never reach the snapshot, a log line or a response.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';
import {
  AGREEMENT_CONFIG_KEYS,
  SIGNING_CONFIG_KEYS,
  parseLaborAgreementConfig,
  parseOperatorEntity,
  signatureMismatches,
  signingState,
  type LaborAgreementConfig,
  type SignatureRequest,
} from '../domain/labor-agreement.ts';
import { maskName } from '../domain/mask-name.ts';
import { insertConsentRecords, lockUserConsents } from '../infra/consent-records.ts';
import { currentLaborAgreementRecord } from '../infra/labor-agreements.ts';
import { verifiedRealnameSigner } from '../infra/realname-reader.ts';
import {
  consistentConfigValues,
  type LaborAgreementConfigReader,
} from '../ports/labor-agreement.ts';
import { lockUserRow } from './consents.ts';

export interface LaborAgreementSubject {
  readonly app_id: string;
  readonly user_id: string;
}

export interface LaborAgreementView {
  readonly version: number;
  readonly text_url: string;
  readonly text_sha256: string;
  readonly need_sign: boolean;
  readonly signed_version: number | null;
  readonly signed_at: string | null;
}

export type ReadLaborAgreementResult =
  { readonly code: 0; readonly data: LaborAgreementView } | { readonly code: 50001 };

export interface SignLaborAgreementCommand extends LaborAgreementSubject {
  /** The request's verified device (signature stage). */
  readonly device_id: string;
  readonly body: SignatureRequest;
}

export type SignLaborAgreementResult =
  | { readonly code: 0 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 30304 }
  | { readonly code: 50001 };

export interface LaborAgreementService {
  read(subject: LaborAgreementSubject): Promise<ReadLaborAgreementResult>;
  sign(trx: Transaction<DB>, command: SignLaborAgreementCommand): Promise<SignLaborAgreementResult>;
}

export interface LaborAgreementOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: Pick<RootLogger, 'warn'>;
  /** app.module's assembly (content's reader on the caller's handle); null when none: 50001. */
  readonly config: LaborAgreementConfigReader | null;
}

/** consent_records.channel of a signature made in the withdrawal flow (BR-WDR-31). */
export const LABOR_AGREEMENT_CHANNEL = 'withdraw_flow';
const CONFIG_INVALID = 'labor_agreement_config_invalid';
const CONFIG_UNASSEMBLED = 'labor_agreement_config_unassembled';
const CONFIG_UNSTABLE = 'labor_agreement_config_unstable';

export function createLaborAgreementService(options: LaborAgreementOptions): LaborAgreementService {
  const { db, clock, crypto, logger, config: reader } = options;

  /** One warn per fault, with the key only (it says which configuration item to fix). */
  function configFault(key: string): { readonly code: 50001 } {
    logger.warn({ config_key: key }, CONFIG_INVALID);
    return { code: 50001 };
  }

  /**
   * The keys' values on `handle` as one committed state (consistentConfigValues), or 50001: no
   * configuration reader assembled, or a configuration that kept changing while read.
   */
  async function configValues(
    handle: Kysely<DB>,
    appId: string,
    keys: readonly string[],
  ): Promise<Map<string, unknown> | { readonly code: 50001 }> {
    if (reader === null) {
      logger.warn({}, CONFIG_UNASSEMBLED);
      return { code: 50001 };
    }
    const read = await consistentConfigValues(reader, handle, appId, keys);
    if (!read.ok) {
      logger.warn({}, CONFIG_UNSTABLE);
      return { code: 50001 };
    }
    return read.values;
  }

  return Object.freeze({
    async read(subject: LaborAgreementSubject): Promise<ReadLaborAgreementResult> {
      // One READ ONLY REPEATABLE READ snapshot: the configuration and the record agree with each
      // other (and the configuration keys with one another) as of one moment.
      const read = await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute(async (trx) => {
          const values = await configValues(trx, subject.app_id, AGREEMENT_CONFIG_KEYS);
          if (!(values instanceof Map)) return values;
          const config = parseLaborAgreementConfig(values);
          if (!config.ok) return config;
          return { config: config.value, record: await currentLaborAgreementRecord(trx, subject) };
        });
      if ('code' in read) return read;
      if ('ok' in read) return configFault(read.key);
      const { config, record } = read;
      const state = signingState(record, config);
      return {
        code: 0,
        data: {
          version: config.version,
          text_url: config.text_url,
          text_sha256: config.text_sha256,
          need_sign: state.need_sign,
          signed_version: state.signed_version,
          signed_at: state.signed_at === null ? null : state.signed_at.toISOString(),
        },
      };
    },

    async sign(
      trx: Transaction<DB>,
      command: SignLaborAgreementCommand,
    ): Promise<SignLaborAgreementResult> {
      const subject = { app_id: command.app_id, user_id: command.user_id };
      await lockUserRow(trx, subject.app_id, subject.user_id);
      await lockUserConsents(trx, subject.app_id, subject.user_id);
      // The idempotency claim's transaction is READ COMMITTED and has already run statements (its
      // isolation can no longer change); consistentConfigValues still yields one committed state.
      const values = await configValues(trx, subject.app_id, SIGNING_CONFIG_KEYS);
      if (!(values instanceof Map)) return values;
      const agreement = parseLaborAgreementConfig(values);
      if (!agreement.ok) return configFault(agreement.key);
      const entity = parseOperatorEntity(values);
      if (!entity.ok) return configFault(entity.key);
      const config: LaborAgreementConfig = agreement.value;
      const fields = signatureMismatches(command.body, config);
      if (fields.length > 0) return { code: 20001, data: { fields } };
      const signer = await verifiedRealnameSigner(trx, crypto, subject);
      if (signer === null) return { code: 30304 };
      const now = clock.now();
      await insertConsentRecords(trx, [
        {
          app_id: subject.app_id,
          subject_type: 'user',
          user_id: subject.user_id,
          device_id: command.device_id,
          type: 'labor_agreement',
          version: config.version,
          accepted: true,
          channel: LABOR_AGREEMENT_CHANNEL,
          text_sha256: config.text_sha256,
          signer_snapshot: JSON.stringify({
            platform: { name: entity.value.name, credit_code: entity.value.credit_code },
            user: {
              user_id: subject.user_id,
              realname_id: signer.id,
              masked_name: maskName(signer.name),
            },
          }),
          client_at: now,
          server_at: now,
          created_at: now,
        },
      ]);
      return { code: 0 };
    },
  });
}
