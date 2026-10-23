// adminEditUserProfile (PATCH /admin/v1/users/{user_id}/profile; 08 BR-ID-44 细则「后台编辑会员信息」,
// BR-ID-39 细则「后台改昵称」, BR-ID-06 正文; task B1-27b). The admin operation guard has already
// checked the account, the point user.phone_change and its totp step-up, and the route schema the
// body, before this runs. Here, for the user (app_id of the admin actor, user_id):
//   1. unknown user, or one of another app → 20001 [user_id];
//   2. phone: normalize_phone (bind-phone.ts) → 20001 [phone] phone_invalid; equal to the current
//      number after normalisation → not edited; nickname: trimmed, 1–16 extended grapheme clusters
//      (update-nickname.ts) → 20001 [nickname]; equal to the current one after trimming → not
//      edited. A field not edited is not written, checked, reviewed or revoked for;
//   3. an edited phone: risk's blocklist (matchRegistration, nothing recorded: a console refusal
//      writes no risk_hits) → 44001, before the occupancy by another account of the app
//      (status <> 'deleted', by the normalised phone_hmac) → 30411 without data, never mergeable;
//   4. an edited nickname: the content-safety review (NicknameReviewPort; anything but 'pass',
//      a throw included, is 20001 [nickname] nickname_sensitive), not counted in the user's
//      3 changes per month;
//   5. in one transaction: users.phone_cipher / phone_hmac and nickname, the old phone_hmac into
//      deleted_identities (reason phone_changed, 180 days), every session of the user revoked
//      (reason phone_changed, with the push token unbinding of app.module's assembly) when the
//      phone changed, and one audit row user_profile_edit (reason, the changed fields with
//      before / after values, phones masked 3 + 4); any failure rolls all of it back.
// TODO(规划/11 §2.3): 后台改号清除待加验标记并解绑可信身份以外的第三方身份（BR-WDR-01 细则） — blocked on 待加验标记的表结构与任务
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';
import type { BlocklistService } from '../../risk/index.ts';
import type { NicknameReviewPort } from '../ports/nickname-review.ts';

/** The audit action of a successful save (contract adminEditUserProfile). */
export type AdminProfileEditAction = 'user_profile_edit';

export interface AdminProfileEditCommand {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
  readonly userId: string;
  readonly body: {
    readonly phone?: string;
    readonly nickname?: string;
    readonly reason: string;
  };
}

export type AdminProfileEditResult =
  | { readonly code: 0 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly ['user_id'] } }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly ['phone']; readonly reason: 'phone_invalid' };
    }
  | { readonly code: 20001; readonly data: { readonly fields: readonly ['nickname'] } }
  | {
      readonly code: 20001;
      readonly data: {
        readonly fields: readonly ['nickname'];
        readonly reason: 'nickname_sensitive';
      };
    }
  | { readonly code: 30411 }
  | { readonly code: 44001 };

export interface AdminProfileEditOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn'>;
  readonly crypto: FieldCrypto;
  readonly review: NicknameReviewPort;
  /** risk's blocklist; only matchRegistration is used (a console refusal records no hit). */
  readonly blocklist: Pick<BlocklistService, 'matchRegistration'>;
  /** Binds the audit port to the save's transaction (app.module: admin's createAuditWriter). */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  /** identity's revocation of every session of the user, on the save's transaction. */
  readonly revokeSessions: (
    trx: Transaction<DB>,
    input: { readonly app_id: string; readonly user_id: string; readonly reason: 'phone_changed' },
  ) => Promise<readonly string[]>;
}

export class AdminProfileEdit {
  constructor(options: AdminProfileEditOptions) {
    void options;
    throw new Error('NotImplemented: AdminProfileEdit');
  }

  edit(command: AdminProfileEditCommand): Promise<AdminProfileEditResult> {
    void command;
    throw new Error('NotImplemented: AdminProfileEdit.edit');
  }
}
