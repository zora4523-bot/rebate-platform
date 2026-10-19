// GET /admin/v1/dict (F1-02zd; 08 BR-TEXT-25; contract adminGetDict). Every key of the bundled
// console defaults (contracts/texts.admin.default.json), with its current override or its default,
// as items[enum][code] split at the key's last dot. The version is judged exactly like GET
// /v1/dict (parseDictVersion): missing or non-string → "0"; a string that is not a published
// version is answered as is, with no overrides and a warning. The version and the admin_dict rows
// come from one snapshot (DictStore.snapshot: version first, then rows, in one REPEATABLE READ
// read-only transaction). Not cached (G3): a console save is visible to the next read.
//
// Pure module (no decorators, erasable syntax).
import type { Schema } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import { adminDictItems, parseDictVersion } from '../domain/dict/index.ts';
import type { DictStore } from './dict-reader.ts';

/** F1-02zd: uncached console read; defaults are loaded on use, store reads one snapshot. */
export class AdminDictReader {
  readonly #store: DictStore | null;
  readonly #defaults: () => Readonly<Record<string, string>>;
  readonly #logger: Pick<Logger, 'warn'>;

  constructor(
    store: DictStore | null,
    defaults: () => Readonly<Record<string, string>>,
    logger: Pick<Logger, 'warn'>,
  ) {
    this.#store = store;
    this.#defaults = defaults;
    this.#logger = logger;
  }

  async read(appId: string): Promise<Schema<'AdminDict'>> {
    const store = this.#store;
    if (store === null) throw new Error('content: console dictionary reads need the database');
    // A broken default file fails the read as is (global filter: 50001), before any query.
    const defaults = this.#defaults();
    const { value, rows } = await store.snapshot(appId, (raw) => parseDictVersion(raw).limit);
    const { version, limit } = parseDictVersion(value);
    if (limit === null) {
      if (value !== undefined && value !== '0') {
        this.#logger.warn(
          { event: 'content_dict_version_invalid', app_id: appId, config_key: 'dict_version' },
          'dictionary version is not a published version; console defaults served',
        );
      }
      return { version, items: adminDictItems(defaults, []) };
    }
    return { version, items: adminDictItems(defaults, rows) };
  }
}
