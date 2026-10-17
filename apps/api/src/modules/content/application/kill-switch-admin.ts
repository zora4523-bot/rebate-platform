import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Logger } from 'pino';
import type { AuditInput, Clock } from '../../platform/index.ts';
import { killSwitchChangeRefusal, killSwitchDescriptor } from '../domain/kill-switch.ts';
import { switchRegistry, switchSpecOf } from '../domain/switch-registry.ts';

type Json = DB['config_items']['value'];
type Switch = Schema<'AdminKillSwitch'>;

export interface KillSwitchRow {
  readonly key: string;
  readonly value: Json;
  readonly version: number;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface KillSwitchActor {
  readonly appId: string;
  readonly adminId: string;
  readonly loginName: string;
  readonly ip: string | null;
  readonly traceId: string;
}

export interface KillSwitchWrite {
  readonly actor: KillSwitchActor;
  readonly key: string;
  readonly value: Json;
  readonly expectedVersion: number;
  readonly reason: string | null;
  readonly at: Date;
}

export interface KillSwitchTx {
  /** Locks an existing row before comparing versions or deciding a same-value no-op. */
  lock(appId: string, key: string): Promise<KillSwitchRow | undefined>;
  /** INSERT ON CONFLICT DO NOTHING for version 0; otherwise a conditional UPDATE. */
  change(input: KillSwitchWrite): Promise<KillSwitchRow | undefined>;
  history(input: KillSwitchWrite, version: number): Promise<void>;
  audit(input: AuditInput): Promise<void>;
}

export interface KillSwitchStore {
  /** Current values on the primary connection, scoped to this app, without caching. */
  rows(appId: string): Promise<readonly KillSwitchRow[]>;
  transaction<T>(work: (tx: KillSwitchTx) => Promise<T>): Promise<T>;
}

export class KillSwitchFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`kill switch: invalid ${fields.join(', ')}`);
    this.name = 'KillSwitchFieldsError';
    this.fields = fields;
  }
}

export class KillSwitchConflictError extends Error {
  constructor() {
    super('kill switch: version conflict');
    this.name = 'KillSwitchConflictError';
  }
}

function switchOf(key: string, row: KillSwitchRow | undefined): Switch {
  const descriptor = killSwitchDescriptor(key);
  if (descriptor === null) throw new Error('content: unregistered switch');
  return {
    key,
    value: row?.value ?? null,
    default: descriptor.default,
    value_type: descriptor.valueType,
    options: descriptor.options === null ? null : [...descriptor.options],
    permissions: [...descriptor.permissions],
    admin_editable: descriptor.adminEditable,
    version: row?.version ?? 0,
    updated_by: row?.updatedBy ?? null,
    updated_at: row?.updatedAt.toISOString() ?? null,
  };
}

/** Permission and step-up checks are the controller's guard; identities are server supplied. */
export class KillSwitchAdmin {
  readonly #store: KillSwitchStore;
  readonly #clock: Clock;
  readonly #logger: Pick<Logger, 'warn'>;

  constructor(store: KillSwitchStore, clock: Clock, logger: Pick<Logger, 'warn'>) {
    this.#store = store;
    this.#clock = clock;
    this.#logger = logger;
  }

  async list(
    appId: string,
    query: { readonly page?: number; readonly page_size?: number },
  ): Promise<Schema<'AdminKillSwitchPage'>> {
    // Query types and bounds have already passed the generated contract route schema.
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const rows = await this.#store.rows(appId);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const items: Switch[] = [];
    for (const spec of switchRegistry()) {
      if (!spec.pattern.includes('<')) {
        items.push(switchOf(spec.pattern, byKey.get(spec.pattern)));
        continue;
      }
      // The contract accepts concrete keys only. Include registered per-placeholder defaults
      // and this app's stored concrete keys; never manufacture platform or tool names.
      const keys = new Set(
        Object.keys(spec.defaultOverrides).map((part) => spec.pattern.replace(/<[^>]+>/u, part)),
      );
      for (const row of rows) {
        if (switchSpecOf(row.key)?.pattern === spec.pattern) keys.add(row.key);
      }
      for (const key of [...keys].sort()) items.push(switchOf(key, byKey.get(key)));
    }
    return {
      items: items.slice((page - 1) * pageSize, page * pageSize),
      page,
      page_size: pageSize,
      total: items.length,
    };
  }

  async update(
    actor: KillSwitchActor,
    key: string,
    body: Schema<'AdminKillSwitchUpdateRequest'>,
  ): Promise<Switch> {
    const refusal = killSwitchChangeRefusal(key, body.value);
    if (refusal !== null) throw new KillSwitchFieldsError([refusal]);
    // All admin-editable entries currently accept only boolean or enum-string values.
    // Keep the store boundary narrow even if a later registry change adds another type.
    if (typeof body.value !== 'boolean' && typeof body.value !== 'string') {
      throw new KillSwitchFieldsError(['value']);
    }
    const value = body.value;
    const result = await this.#store.transaction(async (tx) => {
      const before = await tx.lock(actor.appId, key);
      const fromVersion = before?.version ?? 0;
      if (fromVersion !== body.expected_version) throw new KillSwitchConflictError();
      // Version comparison precedes equality: a stale request can never become a no-op.
      if (before !== undefined && before.value === value) {
        return { row: before, before: before.value, changed: false };
      }
      const input: KillSwitchWrite = {
        actor,
        key,
        value,
        expectedVersion: body.expected_version,
        reason: body.reason ?? null,
        at: this.#clock.now(),
      };
      const row = await tx.change(input);
      // Also covers two concurrent first writes: the unique key picks exactly one winner.
      if (row === undefined) throw new KillSwitchConflictError();
      await tx.history(input, row.version);
      await tx.audit({
        appId: actor.appId,
        actor: actor.adminId,
        action: 'kill_switch_change',
        target: key,
        before: { key, from_version: fromVersion, value: before?.value ?? null },
        after: { key, to_version: row.version, value, reason: input.reason },
        ip: actor.ip,
      });
      return { row, before: before?.value ?? null, changed: true };
    });
    // Only committed changes alert. History/audit failures roll back before reaching this line.
    if (result.changed) {
      this.#logger.warn(
        {
          key,
          from_value: result.before,
          to_value: result.row.value,
          app_id: actor.appId,
          admin_id: actor.adminId,
          trace_id: actor.traceId,
        },
        'config_change_alert',
      );
    }
    return switchOf(key, result.row);
  }
}
