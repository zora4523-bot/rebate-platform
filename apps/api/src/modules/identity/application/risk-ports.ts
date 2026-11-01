// The risk blocklist at identity's three register insertion points (规划/08 BR-ID-05, BR-ID-31,
// BR-ID-36; orchestrator ruling B1-03d §9.3 / §10):
//   1. SMS send (sms-codes.ts hooks): phoneBlocklist checks the phone dimension (44001
//      phone_blocklist); blockedPrefix records the hit of the prefix refusal identity already
//      decided (rule SMS_BLOCKED_PREFIX, dimension phone_prefix, value the phone blind index);
//   2. SMS login before creating an account (sms-login.ts registrationBlocklist): phone and
//      device dimensions, only read in the login transaction (matchRegistration); the hits are
//      written by the refusal's `record`, which sms-login runs after the transaction rolled back
//      and released its connection — nothing borrows a second pooled connection inside it;
//   3. the same-device registration limit (registration.ts allowBlockedRegistration: the
//      one-time release read, default deny; sms-login.ts recordDeviceLimit: the hit of the
//      refusal, rule DEVICE_REGISTER_LIMIT, dimension device, value the device hash).
// Rule status (B1-03zh, BR-ID-36 细则「规则清单的启停」, D10-536): identity's own two decisions ask
// risk's rule status read port (BlocklistService.ruleInForce, the blocklist's own reader and cache)
// before deciding — smsHooks.blockedPrefixInForce (SMS_BLOCKED_PREFIX) and
// registration.deviceLimitInForce (DEVICE_REGISTER_LIMIT, read through the registration's
// transaction). A disabled rule is not judged, so nothing is refused and no hit is due; a risk
// port without ruleInForce leaves both hooks out (in force, as before). One read per judgement
// (money r1 S1): blockedPrefix and recordDeviceLimit run only for a refusal identity has already
// decided on a rule in force, so they go through risk's recordDecidedHit and risk does not read
// the status again (a risk port without it: recordHit, as before); the registration blocklist's record hands back the rows matchRegistration decided
// (risk writes those without a second read). identity keeps no status cache or memo of its own.
// A login-purpose send is a register request (BR-ID-36 请求类型 register: no session, no user);
// bind and step_up sends have no request type yet and no user. A step_up send for
// account_deletion skips the blocklist (BR-ID-31 blocks registration, phone change, payout
// accounts, union filing and withdrawals, not deletion; like BR-ID-01's version gate, nothing may
// keep a user from deleting their data — orchestrator ruling B1-03d §11.3). Risk writes every hit
// in its own short transaction; only the message code reaches the answer, never the request
// number.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';
import type { BlocklistService, RecordBlockedHit } from '../../risk/index.ts';
import { PHONE_BLIND_INDEX_CONTEXT } from '../domain/registration.ts';
import type { RegistrationOptions } from './registration.ts';
import type { SmsHooks, SmsPurpose, SmsRequest } from './sms-codes.ts';
import type { SmsLoginOptions } from './sms-login.ts';
import type { OauthLoginOptions } from './oauth-login.ts';

/** Rule codes of identity's own refusals (orchestrator ruling B1-03d, to be registered in 06). */
export const SMS_BLOCKED_PREFIX_RULE = 'SMS_BLOCKED_PREFIX';
export const DEVICE_REGISTER_LIMIT_RULE = 'DEVICE_REGISTER_LIMIT';
/** Hit dimension of a prefix refusal (risk_hits.dimension is open text). */
export const PHONE_PREFIX_DIMENSION = 'phone_prefix';
/** The step_up action of account deletion, whose code send is exempt from the blocklist. */
const ACCOUNT_DELETION_ACTION = 'account_deletion';

export interface IdentityRiskPorts {
  readonly smsHooks: Pick<SmsHooks, 'phoneBlocklist' | 'blockedPrefix' | 'blockedPrefixInForce'>;
  readonly login: Pick<SmsLoginOptions, 'registrationBlocklist' | 'recordDeviceLimit'>;
  readonly oauthLogin: Pick<OauthLoginOptions, 'registrationBlocklist'>;
  readonly registration: Pick<
    RegistrationOptions,
    'allowBlockedRegistration' | 'deviceLimitInForce'
  >;
}

function requestTypeOf(purpose: SmsPurpose): 'register' | null {
  return purpose === 'login' ? 'register' : null;
}

export function identityRiskPorts(risk: BlocklistService, crypto: FieldCrypto): IdentityRiskPorts {
  const ruleInForce = risk.ruleInForce?.bind(risk);
  // The hit of a refusal identity decided on the rule in force (sms-codes step 2, registration
  // step 5): no second status read when risk offers recordDecidedHit.
  const recordDecided = (input: RecordBlockedHit) =>
    risk.recordDecidedHit === undefined ? risk.recordHit(input) : risk.recordDecidedHit(input);
  return {
    oauthLogin: {
      async registrationBlocklist(trx, input) {
        // This existing read port requires a phone digest. Empty is not a phone HMAC;
        // only device hits are applicable to a third-party registration.
        const block = await risk.matchRegistration(trx, {
          ...input,
          phone_hmac: '',
          related_phone: '',
        });
        const hits = block?.hits.filter((hit) => hit.dimension === 'device') ?? [];
        if (block === null || hits.length === 0) return null;
        // B1-02d D24: no phone to associate with a blocked_request; return only the refusal.
        return {
          code: 44001,
          data: block.data,
        };
      },
    },
    smsHooks: {
      ...(ruleInForce === undefined
        ? {}
        : {
            blockedPrefixInForce: (request: SmsRequest) =>
              ruleInForce({ app_id: request.app_id, rule_id: SMS_BLOCKED_PREFIX_RULE }),
          }),
      async phoneBlocklist(request) {
        if (request.purpose === 'step_up' && request.action === ACCOUNT_DELETION_ACTION) {
          return null;
        }
        const hit = await risk.check({
          app_id: request.app_id,
          dimension: 'phone',
          value: request.phone,
          related_phone: request.phone,
          request_type: requestTypeOf(request.purpose),
        });
        return hit === null
          ? null
          : {
              code: 44001,
              kind: 'phone_blocklist',
              data: { risk_msg_code: hit.data.risk_msg_code },
            };
      },
      async blockedPrefix(request) {
        await recordDecided({
          app_id: request.app_id,
          request_type: requestTypeOf(request.purpose),
          related_phone: request.phone,
          dimension: PHONE_PREFIX_DIMENSION,
          value_hmac: crypto.blindIndex(request.phone, PHONE_BLIND_INDEX_CONTEXT),
          rule_id: SMS_BLOCKED_PREFIX_RULE,
        });
      },
    },
    login: {
      async registrationBlocklist(trx, input) {
        const block = await risk.matchRegistration(trx, {
          app_id: input.app_id,
          phone_hmac: input.phone_hmac,
          ...(input.device_hash === undefined ? {} : { device_hash: input.device_hash }),
          related_phone: input.phone,
        });
        if (block === null) return null;
        const hits = block.hits;
        return {
          code: 44001,
          data: { risk_msg_code: block.data.risk_msg_code },
          record: async () => {
            await risk.recordHits(
              { app_id: input.app_id, request_type: 'register', related_phone: input.phone },
              hits,
            );
          },
        };
      },
      async recordDeviceLimit(input) {
        await recordDecided({
          app_id: input.app_id,
          request_type: 'register',
          related_phone: input.phone,
          dimension: 'device',
          value_hmac: input.device_hash,
          rule_id: DEVICE_REGISTER_LIMIT_RULE,
        });
      },
    },
    registration: {
      allowBlockedRegistration: (trx, input) => risk.allowBlockedRegistration(trx, input),
      ...(ruleInForce === undefined
        ? {}
        : {
            deviceLimitInForce: (trx: Transaction<DB>, input: { readonly app_id: string }) =>
              ruleInForce({ app_id: input.app_id, rule_id: DEVICE_REGISTER_LIMIT_RULE }, trx),
          }),
    },
  };
}
