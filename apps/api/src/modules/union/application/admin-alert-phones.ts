// Admin alert phones of the station-owner authorization SMS (B1-22g; BR-ID-24 ② and 细则
// 「后台联盟账号列表」「后台告警手机号与重新授权会话」, D10-152 ④, D10-176; BR-ID-33; BR-ID-05 细则
// 「手机号规范化」; contract adminListUnionAlertPhones / adminAddUnionAlertPhone /
// adminRemoveUnionAlertPhone). The group lives encrypted in union.auth_alert_phones, read through
// content's reader and written only through content's dedicated write port (D10-281) inside
// union's transaction, together with union's audit row.
//
// Skeleton of the test round: every member throws NotImplemented.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader, UnionAlertPhonesWriter } from '../../content/index.ts';
import type { Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';
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

export class AdminUnionAlertPhonesService {
  constructor(options: AdminUnionAlertPhonesOptions) {
    void options;
    throw new Error('NotImplemented: AdminUnionAlertPhonesService');
  }

  list(actor: AdminUnionAlertPhoneActor): Promise<AdminUnionAlertPhones> {
    void actor;
    throw new Error('NotImplemented: AdminUnionAlertPhonesService.list');
  }

  add(
    actor: AdminUnionAlertPhoneActor,
    body: AdminUnionAlertPhoneAddRequest,
  ): Promise<AdminUnionAlertPhones> {
    void actor;
    void body;
    throw new Error('NotImplemented: AdminUnionAlertPhonesService.add');
  }

  remove(
    actor: AdminUnionAlertPhoneActor,
    removal: AdminUnionAlertPhoneRemoval,
  ): Promise<AdminUnionAlertPhones> {
    void actor;
    void removal;
    throw new Error('NotImplemented: AdminUnionAlertPhonesService.remove');
  }
}
