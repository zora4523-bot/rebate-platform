import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Logger } from 'pino';
import type { AuditInput, Clock } from '../../platform/index.ts';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
  type ConfigItemSpec,
  type ConfigPermission,
} from '../domain/config-registry.ts';

type Json = DB['config_items']['value'];
type Item = Schema<'AdminConfigItem'>;
type Entry = Schema<'AdminConfigItemBatchEntry'>;
export type ConfigPageQuery = { readonly page?: number; readonly page_size?: number };

export interface ConfigItemRow {
  readonly key: string;
  readonly value: Json;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

export interface ConfigItemActor {
  readonly appId: string;
  readonly adminId: string;
  readonly loginName: string;
  readonly ip: string | null;
  readonly traceId: string;
}

export interface ConfigItemWrite {
  readonly actor: ConfigItemActor;
  readonly key: string;
  readonly value: Json;
  readonly expectedVersion: number;
  readonly reason: string | null;
  readonly at: Date;
}

export interface ConfigItemTx {
  lock(appId: string, key: string): Promise<ConfigItemRow | undefined>;
  version(appId: string, key: string, version: number): Promise<{ value: Json } | undefined>;
  change(input: ConfigItemWrite): Promise<ConfigItemRow | undefined>;
  history(input: ConfigItemWrite, version: number): Promise<void>;
  audit(input: AuditInput): Promise<void>;
}

export interface ConfigItemStore {
  rows(appId: string): Promise<readonly ConfigItemRow[]>;
  row(appId: string, key: string): Promise<ConfigItemRow | undefined>;
  versions(
    appId: string,
    key: string,
    page: number,
    pageSize: number,
  ): Promise<Schema<'AdminConfigItemVersionPage'>>;
  transaction<T>(work: (tx: ConfigItemTx) => Promise<T>): Promise<T>;
}

export class ConfigItemFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`config item: invalid ${fields.join(', ')}`);
    this.name = 'ConfigItemFieldsError';
    this.fields = fields;
  }
}

export class ConfigItemConflictError extends Error {
  constructor() {
    super('config item: version conflict');
    this.name = 'ConfigItemConflictError';
  }
}

export function requireConfigItem(key: string, writable = false): ConfigItemSpec {
  const spec = configItemSpecOf(key);
  if (spec === null || (writable && !spec.adminEditable)) {
    throw new ConfigItemFieldsError(['key']);
  }
  return spec;
}

/** Validate the complete batch before any version read, and select its one guard point. */
export function configBatchPermission(items: readonly Entry[]): ConfigPermission {
  const points = new Set<ConfigPermission>();
  const keys = new Set<string>();
  const failed: string[] = [];
  for (const item of items) {
    if (keys.has(item.key)) throw new ConfigItemFieldsError(['items']);
    keys.add(item.key);
    const spec = configItemSpecOf(item.key);
    if (spec !== null) points.add(spec.permission);
    if (spec === null || !spec.adminEditable || !configValueFits(spec, item.value)) {
      failed.push(item.key);
    }
  }
  if (points.size > 1 || items.length === 0) throw new ConfigItemFieldsError(['items']);
  if (failed.length > 0) throw new ConfigItemFieldsError(failed);
  const point = points.values().next().value;
  if (point === undefined) throw new ConfigItemFieldsError(['items']);
  return point;
}

function itemOf(key: string, row: ConfigItemRow | undefined): Item {
  const spec = requireConfigItem(key);
  return {
    key,
    value: row?.value ?? null,
    value_type: spec.valueType,
    options: spec.options === null ? null : [...spec.options],
    permission: spec.permission,
    admin_editable: spec.adminEditable,
    version: row?.version ?? 0,
    updated_by: row?.updatedBy ?? null,
    updated_at: row?.updatedAt.toISOString() ?? null,
  };
}

/** JSON equality ignores object key order, preserves array order, and treats -0 as 0. */
function sameValue(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]!))
    );
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key]!, right[key]!))
  );
}

interface ChangeResult {
  readonly row: ConfigItemRow;
  readonly before: Json;
  readonly changed: boolean;
}

export class ConfigItemAdmin {
  readonly #store: ConfigItemStore;
  readonly #clock: Clock;
  readonly #logger: Pick<Logger, 'warn'>;

  constructor(store: ConfigItemStore, clock: Clock, logger: Pick<Logger, 'warn'>) {
    this.#store = store;
    this.#clock = clock;
    this.#logger = logger;
  }

  async list(appId: string, query: ConfigPageQuery): Promise<Schema<'AdminConfigItemPage'>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const rows = new Map((await this.#store.rows(appId)).map((row) => [row.key, row]));
    const specs = configRegistry();
    return {
      items: specs
        .slice((page - 1) * pageSize, page * pageSize)
        .map((spec) => itemOf(spec.key, rows.get(spec.key))),
      page,
      page_size: pageSize,
      total: specs.length,
    };
  }

  async get(appId: string, key: string): Promise<Item> {
    requireConfigItem(key);
    return itemOf(key, await this.#store.row(appId, key));
  }

  async versions(
    appId: string,
    key: string,
    query: ConfigPageQuery,
  ): Promise<Schema<'AdminConfigItemVersionPage'>> {
    requireConfigItem(key);
    return this.#store.versions(appId, key, query.page ?? 1, query.page_size ?? 20);
  }

  async update(
    actor: ConfigItemActor,
    key: string,
    body: Schema<'AdminConfigItemUpdateRequest'>,
  ): Promise<Item> {
    const spec = requireConfigItem(key, true);
    if (!configValueFits(spec, body.value)) throw new ConfigItemFieldsError(['value']);
    const result = await this.#store.transaction(async (tx) => {
      const before = await tx.lock(actor.appId, key);
      return this.#change(tx, actor, { key, ...body }, before, body.reason ?? null);
    });
    this.#alert(actor, result);
    return itemOf(key, result.row);
  }

  async batch(
    actor: ConfigItemActor,
    body: Schema<'AdminConfigItemBatchRequest'>,
  ): Promise<Schema<'AdminConfigItemList'>> {
    configBatchPermission(body.items);
    const results = await this.#store.transaction(async (tx) => {
      // Finish each key in sorted order, including INSERTs: absent rows cannot be locked
      // by SELECT FOR UPDATE. Any later conflict rolls back every earlier key's writes.
      const sorted = [...body.items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const changed = new Map<string, ChangeResult>();
      for (const item of sorted) {
        const before = await tx.lock(actor.appId, item.key);
        changed.set(item.key, await this.#change(tx, actor, item, before, body.reason ?? null));
      }
      return body.items.map((item) => changed.get(item.key)!);
    });
    for (const result of results) this.#alert(actor, result);
    return { items: results.map((result) => itemOf(result.row.key, result.row)) };
  }

  async rollback(
    actor: ConfigItemActor,
    key: string,
    body: Schema<'AdminConfigItemRollbackRequest'>,
  ): Promise<Item> {
    const spec = requireConfigItem(key, true);
    const result = await this.#store.transaction(async (tx) => {
      const before = await tx.lock(actor.appId, key);
      const historical = await tx.version(actor.appId, key, body.to_version);
      // Check the historical value and target before the expected_version comparison.
      if (
        before === undefined ||
        body.to_version >= before.version ||
        historical === undefined ||
        !configValueFits(spec, historical.value)
      ) {
        throw new ConfigItemFieldsError(['to_version']);
      }
      return this.#change(
        tx,
        actor,
        { key, value: historical.value, expected_version: body.expected_version },
        before,
        body.reason ?? null,
        body.to_version,
      );
    });
    this.#alert(actor, result);
    return itemOf(key, result.row);
  }

  async #change(
    tx: ConfigItemTx,
    actor: ConfigItemActor,
    item: Entry,
    before: ConfigItemRow | undefined,
    reason: string | null,
    restoredVersion?: number,
  ): Promise<ChangeResult> {
    const fromVersion = before?.version ?? 0;
    if (fromVersion !== item.expected_version) throw new ConfigItemConflictError();
    // The generated request schema accepts JSON; registry validation has checked its type.
    const value = item.value as Json;
    // Rollback explicitly records a new version, even if the historical value is current.
    if (restoredVersion === undefined && before !== undefined && sameValue(before.value, value)) {
      return { row: before, before: before.value, changed: false };
    }
    const input: ConfigItemWrite = {
      actor,
      key: item.key,
      value,
      expectedVersion: item.expected_version,
      reason,
      at: this.#clock.now(),
    };
    const row = await tx.change(input);
    if (row === undefined) throw new ConfigItemConflictError();
    await tx.history(input, row.version);
    await tx.audit({
      appId: actor.appId,
      actor: actor.adminId,
      action: restoredVersion === undefined ? 'config_item_change' : 'config_item_rollback',
      target: item.key,
      before: { key: item.key, from_version: fromVersion, value: before?.value ?? null },
      after: {
        key: item.key,
        to_version: row.version,
        value,
        reason,
        ...(restoredVersion === undefined ? {} : { restored_version: restoredVersion }),
      },
      ip: actor.ip,
    });
    return { row, before: before?.value ?? null, changed: true };
  }

  #alert(actor: ConfigItemActor, result: ChangeResult): void {
    // Call only after commit: failures in any key's history/audit leave no alert behind.
    if (!result.changed) return;
    this.#logger.warn(
      {
        key: result.row.key,
        from_value: result.before,
        to_value: result.row.value,
        app_id: actor.appId,
        admin_id: actor.adminId,
        trace_id: actor.traceId,
      },
      'config_change_alert',
    );
  }
}
