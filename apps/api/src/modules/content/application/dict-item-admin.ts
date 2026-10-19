// The admin dictionary editor (F1-02t; 规划/08 BR-TEXT-12 细则, contract /admin/v1/dict-items*):
// list, history, save-and-publish and rollback. Every write runs in one transaction: lock the
// dict_version row (FOR UPDATE; none = "0"), check every item, compare expected_version, then
// insert the new dict_items rows, move dict_version (config_items and its history) and append the
// audit row. A refused write leaves nothing behind.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { AuditInput, Clock } from '../../platform/index.ts';
import {
  checkDictRollback,
  checkDictSave,
  dictRequestClass,
  parseWritableDictVersion,
  type DictTextRules,
} from '../domain/dict/index.ts';
import {
  classifyTextKey,
  type FundTermKeys,
  type TextKeyClass,
} from '../domain/text-guard/index.ts';

type Json = DB['config_items']['value'];
export type DictKeyClass = TextKeyClass;

export interface DictItemActor {
  readonly appId: string;
  readonly adminId: string;
  readonly loginName: string;
  readonly ip: string | null;
}

export interface DictListQuery {
  readonly class?: DictKeyClass;
  readonly key_prefix?: string;
  readonly page?: number;
  readonly page_size?: number;
}

export interface DictHistoryQuery {
  readonly key?: string;
  readonly page?: number;
  readonly page_size?: number;
}

/** A key's newest stored row at or below some dictionary version. */
export interface DictEffective {
  readonly text: string | null;
  readonly version: number;
}

export interface DictVersionRow {
  readonly value: Json;
  readonly version: number;
}

export interface DictItemInsert {
  readonly appId: string;
  readonly key: string;
  readonly version: number;
  readonly text: string | null;
  readonly createdBy: string;
  readonly at: Date;
}

export interface DictPublish {
  readonly actor: DictItemActor;
  /** The locked row; undefined = first publish (insert). */
  readonly previous: DictVersionRow | undefined;
  /** The new dict_version, stored as a JSON string. */
  readonly value: string;
  readonly at: Date;
}

export interface DictReadTx {
  /** config_items dict_version of the app; undefined = no row ("0"). */
  dictVersion(appId: string): Promise<DictVersionRow | undefined>;
  /** Each key's newest row with version ≤ atVersion; all keys when `keys` is undefined. */
  effective(
    appId: string,
    atVersion: number,
    keys?: readonly string[],
  ): Promise<ReadonlyMap<string, DictEffective>>;
}

export interface DictWriteTx extends DictReadTx {
  /** dict_version row of the app, locked FOR UPDATE until the transaction ends. */
  lockVersion(appId: string): Promise<DictVersionRow | undefined>;
  /** Insert (first publish) or bump the locked row, and append config_item_versions. */
  publish(input: DictPublish): Promise<void>;
  insertItems(rows: readonly DictItemInsert[]): Promise<void>;
  audit(input: AuditInput): Promise<void>;
}

export interface DictItemStore {
  /** One consistent snapshot (repeatable read) for a list. */
  read<T>(work: (tx: DictReadTx) => Promise<T>): Promise<T>;
  history(
    appId: string,
    key: string | null,
    page: number,
    pageSize: number,
  ): Promise<Schema<'AdminDictItemVersionPage'>>;
  /** One write transaction; a unique violation on the version rows surfaces as DictConflictError. */
  transaction<T>(work: (tx: DictWriteTx) => Promise<T>): Promise<T>;
  /** An audit row on its own (refused fund term writes, BR-TEXT-12 细则「写入口统一」). */
  appendAudit(input: AuditInput): Promise<void>;
}

export interface DictSpecs {
  /** contracts/texts.default.json `texts`: the keys the dictionary may override. */
  readonly defaults: () => Readonly<Record<string, string>>;
  readonly rules: () => DictTextRules;
  readonly fundTermKeys: () => FundTermKeys;
}

export class DictFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`dict items: invalid ${fields.join(', ')}`);
    this.name = 'DictFieldsError';
    this.fields = fields;
  }
}

export class DictConflictError extends Error {
  constructor() {
    super('dict items: dictionary version conflict');
    this.name = 'DictConflictError';
  }
}

/** The stored dict_version is not a decimal integer string: a data error (50001, L47). */
export class DictVersionCorruptError extends Error {
  constructor(appId: string) {
    super(`dict items: dict_version of ${appId} is not a decimal integer string`);
    this.name = 'DictVersionCorruptError';
  }
}

type SaveBody = Schema<'AdminDictSaveRequest'>;
type RollbackBody = Schema<'AdminDictRollbackRequest'>;
type SaveResult = Schema<'AdminDictSaveResult'>;
type Pair = { readonly key: string; readonly text: string | null };

/** The class of one write request; empty or mixed → 20001 on `field` (before any permission). */
export function requireDictClass(
  keys: readonly string[],
  fundTermKeys: FundTermKeys,
  field: 'changes' | 'keys',
): DictKeyClass {
  const keyClass = dictRequestClass(keys, fundTermKeys);
  if (keyClass === null) throw new DictFieldsError([field]);
  return keyClass;
}

function versionValue(row: DictVersionRow | undefined): Json {
  return row === undefined ? '0' : row.value;
}

/** Display value of dict_version for reads: a string as stored, anything else "0" (L47). */
function displayVersion(value: Json): string {
  return typeof value === 'string' && value.length > 0 ? value : '0';
}

export class DictItemAdmin {
  readonly #store: DictItemStore;
  readonly #clock: Clock;
  readonly #specs: DictSpecs;

  constructor(store: DictItemStore, clock: Clock, specs: DictSpecs) {
    this.#store = store;
    this.#clock = clock;
    this.#specs = specs;
  }

  /** The single class of a write's keys (20001 on `field` when empty or mixed). */
  requestClass(keys: readonly string[], field: 'changes' | 'keys'): DictKeyClass {
    return requireDictClass(keys, this.#specs.fundTermKeys(), field);
  }

  async list(appId: string, query: DictListQuery): Promise<Schema<'AdminDictItemPage'>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const defaults = this.#specs.defaults();
    const fundTermKeys = this.#specs.fundTermKeys();
    const prefix = query.key_prefix;
    const keys = Object.keys(defaults)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => ({ key, keyClass: classifyTextKey(key, fundTermKeys) }))
      .filter(
        (item) =>
          (query.class === undefined || item.keyClass === query.class) &&
          (prefix === undefined || item.key.startsWith(prefix)),
      );
    const slice = keys.slice((page - 1) * pageSize, page * pageSize);
    const { value, effective } = await this.#store.read(async (tx) => {
      const current = versionValue(await tx.dictVersion(appId));
      // A corrupt dict_version publishes nothing (as GET /v1/dict); the value is shown as stored.
      const at = parseWritableDictVersion(current) ?? 0;
      return {
        value: current,
        effective:
          slice.length === 0 || at === 0
            ? new Map<string, DictEffective>()
            : await tx.effective(
                appId,
                at,
                slice.map((item) => item.key),
              ),
      };
    });
    return {
      items: slice.map((item) => {
        const row = effective.get(item.key);
        return {
          key: item.key,
          class: item.keyClass,
          default_text: defaults[item.key]!,
          text: row?.text ?? null,
          version: row?.version ?? null,
        };
      }),
      page,
      page_size: pageSize,
      total: keys.length,
      dict_version: displayVersion(value),
    };
  }

  history(appId: string, query: DictHistoryQuery): Promise<Schema<'AdminDictItemVersionPage'>> {
    return this.#store.history(appId, query.key ?? null, query.page ?? 1, query.page_size ?? 20);
  }

  async save(actor: DictItemActor, body: SaveBody): Promise<SaveResult> {
    const keys = body.changes.map((change) => change.key);
    const keyClass = requireDictClass(keys, this.#specs.fundTermKeys(), 'changes');
    const legal = body.legal_confirmed_by ?? null;
    return this.#store.transaction(async (tx) => {
      const { row, current } = await this.#lock(tx, actor.appId);
      const before = await tx.effective(actor.appId, current, keys);
      const fields = checkDictSave({
        changes: body.changes,
        keyClass,
        legalConfirmedBy: legal,
        current: (key) => before.get(key)?.text ?? null,
        rules: this.#specs.rules(),
      });
      if (fields.length > 0) throw new DictFieldsError(fields);
      return this.#publish(tx, actor, {
        row,
        current,
        expected: body.expected_version,
        before: keys.map((key) => ({ key, text: before.get(key)?.text ?? null })),
        after: body.changes.map((change) => ({ key: change.key, text: change.text })),
        action: 'dict_items_save',
        extra: { fund_terms: keyClass === 'fund_terms', legal_confirmed_by: legal },
      });
    });
  }

  async rollback(actor: DictItemActor, body: RollbackBody): Promise<SaveResult> {
    const keyClass = requireDictClass(body.keys, this.#specs.fundTermKeys(), 'keys');
    const legal = body.legal_confirmed_by ?? null;
    return this.#store.transaction(async (tx) => {
      const { row, current } = await this.#lock(tx, actor.appId);
      const before = await tx.effective(actor.appId, current, body.keys);
      const restored =
        body.to_version > 0 && body.to_version < current
          ? await tx.effective(actor.appId, body.to_version, body.keys)
          : new Map<string, DictEffective>();
      const fields = checkDictRollback({
        keys: body.keys,
        toVersion: body.to_version,
        currentVersion: current,
        keyClass,
        legalConfirmedBy: legal,
        restored: (key) => restored.get(key)?.text ?? null,
        rules: this.#specs.rules(),
      });
      if (fields.length > 0) throw new DictFieldsError(fields);
      return this.#publish(tx, actor, {
        row,
        current,
        expected: body.expected_version,
        before: body.keys.map((key) => ({ key, text: before.get(key)?.text ?? null })),
        after: body.keys.map((key) => ({ key, text: restored.get(key)?.text ?? null })),
        action: 'dict_items_rollback',
        extra: {
          fund_terms: keyClass === 'fund_terms',
          legal_confirmed_by: legal,
          to_version: body.to_version,
        },
      });
    });
  }

  /** A refused fund term write: the keys asked for and the refusal code, on its own row. */
  denied(
    actor: Omit<DictItemActor, 'loginName'>,
    operation: 'save' | 'rollback',
    keys: readonly string[],
    code: number,
  ): Promise<void> {
    return this.#store.appendAudit({
      appId: actor.appId,
      actor: actor.adminId,
      action: 'dict_items_denied',
      target: 'dict_items',
      before: null,
      after: { operation, keys: [...keys], code, fund_terms: true },
      ip: actor.ip,
    });
  }

  async #lock(
    tx: DictWriteTx,
    appId: string,
  ): Promise<{ row: DictVersionRow | undefined; current: number }> {
    const row = await tx.lockVersion(appId);
    const current = parseWritableDictVersion(versionValue(row));
    if (current === null) throw new DictVersionCorruptError(appId);
    return { row, current };
  }

  async #publish(
    tx: DictWriteTx,
    actor: DictItemActor,
    input: {
      readonly row: DictVersionRow | undefined;
      readonly current: number;
      readonly expected: string;
      readonly before: readonly Pair[];
      readonly after: readonly Pair[];
      readonly action: 'dict_items_save' | 'dict_items_rollback';
      readonly extra: Readonly<Record<string, Json>>;
    },
  ): Promise<SaveResult> {
    // Compare only after every item passed (contract: checks first, then CAS); strict string match.
    const currentValue = String(input.current);
    if (input.expected !== currentValue) throw new DictConflictError();
    const next = String(input.current + 1);
    const at = this.#clock.now();
    await tx.publish({ actor, previous: input.row, value: next, at });
    await tx.insertItems(
      input.after.map((pair) => ({
        appId: actor.appId,
        key: pair.key,
        version: input.current + 1,
        text: pair.text,
        createdBy: actor.adminId,
        at,
      })),
    );
    await tx.audit({
      appId: actor.appId,
      actor: actor.adminId,
      action: input.action,
      target: 'dict_items',
      before: { dict_version: currentValue, items: input.before.map((pair) => ({ ...pair })) },
      after: {
        dict_version: next,
        items: input.after.map((pair) => ({ ...pair })),
        ...input.extra,
      },
      ip: actor.ip,
    });
    return { version: next, keys: input.after.map((pair) => pair.key) };
  }
}
