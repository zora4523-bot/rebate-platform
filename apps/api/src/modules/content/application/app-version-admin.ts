// F1-02zc: the console's version settings (/admin/v1/app-versions*; contract adminListAppVersions,
// adminGetAppVersion, adminSaveAppVersion; 04 §6.6 app-versions, §11.2 content.app_version;
// 08 BR-ID-01 细则「【去更新】打开哪家商店与保存前的核对」; task §9.2 Y1–Y6).
// Reads: every row of the app ordered by platform, then channel (h5 and admin included, read only);
// a row that does not fit AdminAppVersion is skipped from the list with a warning and answers
// 50001 when read alone (Y6). Save (Y2 order, after the route schema and the guard):
// validateAdminAppVersionSave (20001) → warning while the store table is empty → one transaction:
// current row FOR UPDATE → CAS on expected_row_version (20902, resource app_version) → the row
// must still be the one the step-up tier was chosen from (Y1, else 20902) → checkAppVersionSave on
// the locked row and the saved values (20001) → insert (id UUIDv7, row_version 0) or whole-row
// update (row_version + 1, also when nothing changed, Y3) → audit (Y4). Any refusal throws, so the
// transaction rolls back and the guard never consumes the step-up token.
import type { Schema } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import type { AuditInput, Clock } from '../../platform/index.ts';
import {
  checkAppVersionSave,
  isMinSupportedRaise,
  type AppVersionMinimum,
  type AppVersionSaveInput,
  type AppVersionSaveRow,
  type AppVersionStoreListing,
} from '../domain/app-versions/index.ts';
import { isAppVersionUri } from '../domain/app-version.ts';
import { storeKeysFor, validateAdminAppVersionSave } from './app-version-admin-validation.ts';

export type AdminAppVersionView = Schema<'AdminAppVersion'>;
export type AdminAppVersionSaveBody = Schema<'AdminAppVersionSaveRequest'>;
export type EditablePlatform = AppVersionSaveRow['platform'];

/** The operation of content.app_version whose tier is totp (specs/permissions.yaml). */
export const RAISE_MIN_SUPPORTED_OPERATION = 'content.app_version.raise_min_supported_version';

/** One app_versions row as stored; store_listings is unchecked JSON. */
export interface AppVersionRecord {
  readonly platform: string;
  readonly channel: string;
  readonly latest_version: string;
  readonly min_supported_version: string | null;
  readonly recommended_version: string | null;
  readonly update_title: string;
  readonly update_notes: string;
  readonly store_url: string;
  readonly default_store: string;
  readonly store_listings: unknown;
  readonly row_version: number;
  readonly updated_at: Date;
}

/** The values a save writes. */
export interface AppVersionWrite {
  readonly appId: string;
  readonly row: AppVersionSaveRow;
  readonly at: Date;
}

export interface AppVersionTx {
  /** The current row, locked FOR UPDATE until the transaction ends. */
  lock(appId: string, platform: string, channel: string): Promise<AppVersionRecord | undefined>;
  /** New row (row_version 0); undefined when a concurrent save created it first. */
  insert(id: string, write: AppVersionWrite): Promise<AppVersionRecord | undefined>;
  /** Whole-row replacement guarded by row_version; undefined when it no longer matches. */
  update(write: AppVersionWrite, rowVersion: number): Promise<AppVersionRecord | undefined>;
  audit(input: AuditInput): Promise<void>;
}

export interface AppVersionAdminStore {
  rows(appId: string): Promise<readonly AppVersionRecord[]>;
  /** Primary handle, no lock: the pre-read that chooses the step-up tier (Y1). */
  row(appId: string, platform: string, channel: string): Promise<AppVersionRecord | undefined>;
  transaction<T>(work: (tx: AppVersionTx) => Promise<T>): Promise<T>;
}

export interface AppVersionActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

/** What the step-up tier was chosen from: the row as pre-read (null when there was none). */
export interface AppVersionPreRead {
  readonly appId: string;
  readonly platform: string;
  readonly channel: string;
  readonly row: {
    readonly row_version: number;
    readonly min_supported_version: string | null;
  } | null;
}

export class AppVersionFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`app version: invalid ${fields.join(', ')}`);
    this.name = 'AppVersionFieldsError';
    this.fields = fields;
  }
}

export class AppVersionConflictError extends Error {
  constructor() {
    super('app version: row changed');
    this.name = 'AppVersionConflictError';
  }
}

export class AppVersionNotFoundError extends Error {
  constructor() {
    super('app version: no row for this platform and channel');
    this.name = 'AppVersionNotFoundError';
  }
}

/** A stored row that does not fit AdminAppVersion (Y6); never carries column values. */
export class InvalidAdminAppVersionError extends Error {
  readonly column: string;

  constructor(column: string) {
    super(`content: malformed app_versions column ${column}`);
    this.name = 'InvalidAdminAppVersionError';
    this.column = column;
  }
}

const PLATFORMS: ReadonlySet<string> = new Set(['ios', 'android', 'harmony', 'h5', 'admin']);
const CHANNELS: ReadonlySet<string> = new Set(['appstore', 'official', 'huawei', 'agc']);
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const INT32_MAX = 2_147_483_647;

const isVersion = (value: unknown): value is string =>
  typeof value === 'string' && SEMVER.test(value);

function parseListings(value: unknown): AppVersionStoreListing[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const listings: AppVersionStoreListing[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'store' && key !== 'listed_version')) {
      return undefined;
    }
    const store = record['store'];
    const version = record['listed_version'];
    if (typeof store !== 'string' || store.length === 0) return undefined;
    if (version !== null && !isVersion(version)) return undefined;
    listings.push({ store, listed_version: version });
  }
  return listings;
}

/** Y6: the stored row as AdminAppVersion, or the first column that does not fit. */
export function adminAppVersionView(record: AppVersionRecord): AdminAppVersionView {
  if (!PLATFORMS.has(record.platform)) throw new InvalidAdminAppVersionError('platform');
  if (!CHANNELS.has(record.channel)) throw new InvalidAdminAppVersionError('channel');
  if (!isVersion(record.latest_version)) throw new InvalidAdminAppVersionError('latest_version');
  for (const column of ['min_supported_version', 'recommended_version'] as const) {
    const value = record[column];
    if (value !== null && !isVersion(value)) throw new InvalidAdminAppVersionError(column);
  }
  if (typeof record.update_title !== 'string') {
    throw new InvalidAdminAppVersionError('update_title');
  }
  if (typeof record.update_notes !== 'string') {
    throw new InvalidAdminAppVersionError('update_notes');
  }
  if (!isAppVersionUri(record.store_url)) throw new InvalidAdminAppVersionError('store_url');
  if (record.default_store.length === 0) throw new InvalidAdminAppVersionError('default_store');
  const listings = parseListings(record.store_listings);
  if (listings === undefined) throw new InvalidAdminAppVersionError('store_listings');
  if (!Number.isInteger(record.row_version) || record.row_version < 0) {
    throw new InvalidAdminAppVersionError('row_version');
  }
  if (Number.isNaN(record.updated_at.getTime())) {
    throw new InvalidAdminAppVersionError('updated_at');
  }
  return {
    platform: record.platform as AdminAppVersionView['platform'],
    channel: record.channel as AdminAppVersionView['channel'],
    latest_version: record.latest_version,
    min_supported_version: record.min_supported_version,
    recommended_version: record.recommended_version,
    update_title: record.update_title,
    update_notes: record.update_notes,
    store_url: record.store_url,
    default_store: record.default_store,
    store_listings: listings,
    row_version: record.row_version,
    // §9.12: toISOString (millisecond precision, Z), the form the rule tests compare.
    updated_at: record.updated_at.toISOString(),
  };
}

/** Business columns, platform, channel and row_version of a row, for the audit record. */
function auditRow(record: AppVersionRecord): Record<string, unknown> {
  return {
    platform: record.platform,
    channel: record.channel,
    latest_version: record.latest_version,
    min_supported_version: record.min_supported_version,
    recommended_version: record.recommended_version,
    update_title: record.update_title,
    update_notes: record.update_notes,
    store_url: record.store_url,
    default_store: record.default_store,
    store_listings: record.store_listings,
    row_version: record.row_version,
  };
}

/**
 * The locked row as the "before" of BR-ID-01's check. A stored listing that is not well formed
 * counts as no listing at all, so the check runs in full rather than being skipped.
 */
function beforeRow(record: AppVersionRecord, after: AppVersionSaveRow): AppVersionSaveRow {
  return {
    platform: after.platform,
    channel: after.channel,
    latest_version: record.latest_version,
    min_supported_version: isVersion(record.min_supported_version)
      ? record.min_supported_version
      : null,
    recommended_version: record.recommended_version,
    update_title: record.update_title,
    update_notes: record.update_notes,
    store_url: record.store_url,
    default_store: record.default_store,
    store_listings: parseListings(record.store_listings) ?? [],
  };
}

const byPlatformChannel = (a: AdminAppVersionView, b: AdminAppVersionView): number =>
  a.platform !== b.platform
    ? a.platform < b.platform
      ? -1
      : 1
    : a.channel === b.channel
      ? 0
      : a.channel < b.channel
        ? -1
        : 1;

export interface AppVersionAdminDeps {
  readonly store: AppVersionAdminStore;
  readonly clock: Clock;
  readonly logger: Pick<Logger, 'warn'>;
  /** UUIDv7 of a write instant (platform's newUuidV7). */
  readonly newId: (at: Date) => string;
  /** Y5: store keys of a platform and channel (default: the generated APP_STORES table). */
  readonly storeKeys?: (platform: string, channel: string) => readonly string[];
}

export class AppVersionAdmin {
  readonly #store: AppVersionAdminStore;
  readonly #clock: Clock;
  readonly #logger: Pick<Logger, 'warn'>;
  readonly #newId: (at: Date) => string;
  readonly #storeKeys: (platform: string, channel: string) => readonly string[];

  constructor(deps: AppVersionAdminDeps) {
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#newId = deps.newId;
    // Looked up per call, so the table boundary stays replaceable.
    this.#storeKeys = deps.storeKeys ?? ((platform, channel) => storeKeysFor(platform, channel));
  }

  async list(appId: string): Promise<Schema<'AdminAppVersionList'>> {
    const items: AdminAppVersionView[] = [];
    for (const record of await this.#store.rows(appId)) {
      try {
        items.push(adminAppVersionView(record));
      } catch (error) {
        if (!(error instanceof InvalidAdminAppVersionError)) throw error;
        // Platform and channel are bounded by the table's own check / text column: no secrets.
        this.#logger.warn(
          {
            app_id: appId,
            platform: record.platform,
            channel: record.channel,
            column: error.column,
          },
          'content_app_version_invalid',
        );
      }
    }
    return { items: items.sort(byPlatformChannel) };
  }

  async get(appId: string, platform: string, channel: string): Promise<AdminAppVersionView> {
    const record = await this.#store.row(appId, platform, channel);
    if (record === undefined) throw new AppVersionNotFoundError();
    return adminAppVersionView(record);
  }

  /** Y1: the unlocked primary read that decides whether this save needs the totp tier. */
  async preRead(appId: string, platform: string, channel: string): Promise<AppVersionPreRead> {
    const record = await this.#store.row(appId, platform, channel);
    return {
      appId,
      platform,
      channel,
      row:
        record === undefined
          ? null
          : {
              row_version: record.row_version,
              min_supported_version: record.min_supported_version,
            },
    };
  }

  async save(
    actor: AppVersionActor,
    platform: EditablePlatform,
    channel: string,
    body: AdminAppVersionSaveBody,
    pre: AppVersionPreRead,
  ): Promise<AdminAppVersionView> {
    if (pre.appId !== actor.appId || pre.platform !== platform || pre.channel !== channel) {
      throw new Error('content: app version pre-read does not belong to this save');
    }
    const { expected_row_version: expected, ...fields } = body;
    const input = { ...fields, platform, channel };
    const validation = validateAdminAppVersionSave(input, this.#storeKeys(platform, channel));
    if (!validation.ok) throw new AppVersionFieldsError(validation.fields);
    if (validation.store_table_empty) {
      this.#logger.warn(
        { app_id: actor.appId, platform, channel },
        'content_app_version_store_keys_unset: specs/app-stores.yaml has no store key for this platform and channel; only the key format was checked',
      );
    }
    // Validated: platform / channel pair and every field have their domain types now.
    const after = input as AppVersionSaveInput;
    const row: AppVersionSaveRow = {
      platform: after.platform,
      channel: after.channel,
      latest_version: after.latest_version,
      min_supported_version: after.min_supported_version,
      recommended_version: after.recommended_version,
      update_title: after.update_title,
      update_notes: after.update_notes,
      store_url: after.store_url,
      default_store: after.default_store,
      store_listings: after.store_listings.map((listing) => ({
        store: listing.store,
        listed_version: listing.listed_version,
      })),
    };

    const saved = await this.#store.transaction(async (tx) => {
      const current = await tx.lock(actor.appId, platform, channel);
      // CAS (04 §6.6): null ⇔ no row; a number ⇔ the row's row_version.
      if (current === undefined ? expected !== null : expected !== current.row_version) {
        throw new AppVersionConflictError();
      }
      // Y1: the tier was chosen from the pre-read; any change since then is a conflict.
      if (
        current === undefined
          ? pre.row !== null
          : pre.row === null ||
            pre.row.row_version !== current.row_version ||
            pre.row.min_supported_version !== current.min_supported_version
      ) {
        throw new AppVersionConflictError();
      }
      const check = checkAppVersionSave(
        current === undefined ? null : beforeRow(current, row),
        after,
      );
      if (!check.ok) throw new AppVersionFieldsError(check.fields);

      const write: AppVersionWrite = { appId: actor.appId, row, at: this.#clock.now() };
      const stored =
        current === undefined
          ? await tx.insert(this.#newId(write.at), write)
          : current.row_version >= INT32_MAX
            ? undefined
            : await tx.update(write, current.row_version);
      if (stored === undefined) throw new AppVersionConflictError();
      await tx.audit({
        appId: actor.appId,
        actor: actor.adminId,
        action: 'app_version_save',
        target: `${platform}/${channel}`,
        before: current === undefined ? null : (auditRow(current) as AuditInput['before']),
        after: {
          ...auditRow(stored),
          // Y4: only the stores actually below the minimum, in store_listings order.
          confirmed_stores: [...check.confirmed],
        } as AuditInput['after'],
        ip: actor.ip,
      });
      return stored;
    });
    return adminAppVersionView(saved);
  }
}

/** Y1: the same raise predicate as the save check, applied to the pre-read row. */
export function needsRaiseStepUp(
  pre: AppVersionPreRead,
  body: Pick<AdminAppVersionSaveBody, 'min_supported_version'>,
): boolean {
  const next = body.min_supported_version;
  // The route schema has checked the format; anything else is refused by the save (20001).
  if (next === null || !isVersion(next)) return false;
  const previous = pre.row === null ? null : pre.row.min_supported_version;
  // A stored minimum that cannot be compared (the table's check forbids it) counts as none.
  const before: AppVersionMinimum | null =
    previous === null || !isVersion(previous) ? null : { min_supported_version: previous };
  return isMinSupportedRaise(before, { min_supported_version: next });
}
