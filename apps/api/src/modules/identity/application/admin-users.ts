import type { Schema } from '@couli/contracts-ts';
import type { FieldCrypto } from '../../platform/index.ts';
import { normalize_phone } from '../domain/normalize-phone.ts';
import { PHONE_BLIND_INDEX_CONTEXT } from '../domain/registration.ts';
import {
  projectAdminUser,
  type AdminUserViewReader,
  type AdminUserViewSource,
} from './admin-user-view.ts';

export interface AdminUserListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly risk_state?: Schema<'AdminUserRiskStateCode'>;
}

export interface AdminUserLookupQuery {
  readonly uid?: string;
  readonly phone?: string;
}

export interface AdminUsersReader extends AdminUserViewReader {
  list(input: {
    readonly appId: string;
    readonly page: number;
    readonly pageSize: number;
    readonly riskState?: Schema<'AdminUserRiskStateCode'>;
  }): Promise<{ readonly items: readonly AdminUserViewSource[]; readonly total: number }>;
  findByPhoneHmac(input: {
    readonly appId: string;
    readonly phoneHmac: string;
  }): Promise<AdminUserViewSource | null>;
}

export class AdminUsersFieldsError extends Error {
  constructor(
    readonly fields: readonly string[],
    readonly reason?: 'phone_invalid',
  ) {
    super('identity: admin user query refused');
    this.name = 'AdminUsersFieldsError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Authorisation precedes these reads; appId is always supplied by the admin guard. */
export class AdminUsers {
  constructor(
    private readonly reader: AdminUsersReader | null,
    private readonly crypto: FieldCrypto | null,
  ) {}

  async list(appId: string, query: AdminUserListQuery): Promise<Schema<'AdminUserPage'>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const result = await this.availableReader().list({
      appId,
      page,
      pageSize,
      ...(query.risk_state === undefined ? {} : { riskState: query.risk_state }),
    });
    return {
      items: result.items.map((source) => projectAdminUser(source, 'list')),
      page,
      page_size: pageSize,
      total: result.total,
    };
  }

  async detail(appId: string, userId: string): Promise<Schema<'AdminUserDetail'>> {
    return this.byId(appId, userId, 'user_id');
  }

  async lookup(appId: string, query: AdminUserLookupQuery): Promise<Schema<'AdminUserDetail'>> {
    // Presence, not truthiness: an explicitly empty phone is phone_invalid.
    if ((query.uid === undefined) === (query.phone === undefined)) {
      throw new AdminUsersFieldsError(['uid', 'phone']);
    }
    if (query.uid !== undefined) return this.byId(appId, query.uid, 'uid');
    const normalized = normalize_phone(query.phone!);
    if (normalized.code !== 0) throw new AdminUsersFieldsError(['phone'], 'phone_invalid');
    if (this.crypto === null) throw new Error('identity: user lookup needs the field cipher');
    const source = await this.availableReader().findByPhoneHmac({
      appId,
      phoneHmac: this.crypto.blindIndex(normalized.phone, PHONE_BLIND_INDEX_CONTEXT),
    });
    if (source === null) throw new AdminUsersFieldsError(['phone']);
    return projectAdminUser(source, 'detail');
  }

  private async byId(
    appId: string,
    userId: string,
    field: 'uid' | 'user_id',
  ): Promise<Schema<'AdminUserDetail'>> {
    if (!UUID.test(userId)) throw new AdminUsersFieldsError([field]);
    const source = await this.availableReader().read({ appId, userId });
    if (source === null) throw new AdminUsersFieldsError([field]);
    return projectAdminUser(source, 'detail');
  }

  private availableReader(): AdminUsersReader {
    if (this.reader === null) throw new Error('identity: user queries need the database');
    return this.reader;
  }
}
