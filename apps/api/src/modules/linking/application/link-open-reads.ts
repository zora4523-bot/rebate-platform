// B1-06m: the reads of one open happen before its transaction. The open holds one database
// connection for its whole transaction (platform idempotency executeInTransaction); a reader that
// went to the connection pool inside it (content's configuration, union's active pid, identity's
// attr_code) would take a second connection, and with the pool full every open would wait for
// another forever. So an open first pre-reads, through these wrappers and outside any transaction,
// every value its stages may need; then it locks the scope and runs the transaction, in which a
// wrapped reader only answers from what was pre-read. A value not pre-read fails the open closed
// (it throws, the transaction rolls back) instead of borrowing a connection.
// Outside an open (card registration, direct use of a stage) the wrappers read straight through.
// B1-19d: the active-pid key carries the optional union account filter (unscoped reads key on
// null), so a scoped and an unscoped read never answer for each other.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { UnionPidService } from '../../union/index.ts';
import type { AttrCodeReader, LinkingConfigReader } from '../ports.ts';

type PidReader = Pick<UnionPidService, 'getActivePid'>;
type PidInput = Parameters<PidReader['getActivePid']>[0];

interface OpenReadStore {
  /** Set once the pre-reads are done: from then on only memoized values answer. */
  locked: boolean;
  /** Per underlying reader object, the memoized reads by key. */
  readonly memo: Map<object, Map<string, Promise<unknown>>>;
}

const scope = new AsyncLocalStorage<OpenReadStore>();

/** Thrown inside an open's transaction for a read that was not pre-read. */
export class OpenReadNotPrepared extends Error {
  constructor(what: string) {
    super(`linking: ${what} was not read before the open's transaction`);
    this.name = 'OpenReadNotPrepared';
  }
}

function through<T>(reader: object, key: string, what: string, load: () => Promise<T>): Promise<T> {
  const store = scope.getStore();
  if (store === undefined) return load();
  let byKey = store.memo.get(reader);
  if (byKey === undefined) {
    byKey = new Map();
    store.memo.set(reader, byKey);
  }
  const known = byKey.get(key);
  if (known !== undefined) return known as Promise<T>;
  if (store.locked) return Promise.reject(new OpenReadNotPrepared(what));
  const value = load();
  byKey.set(key, value);
  return value;
}

/**
 * Runs one open: `prepare` pre-reads through the wrapped readers (no transaction is open yet),
 * then `run` executes with the reads locked to what was pre-read.
 */
export async function withOpenReads<T>(
  prepare: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  const store: OpenReadStore = { locked: false, memo: new Map() };
  return scope.run(store, async () => {
    await prepare();
    store.locked = true;
    return run();
  });
}

export function openScopedConfig(config: LinkingConfigReader): LinkingConfigReader {
  return {
    configValue: (appId, key) =>
      through(config, JSON.stringify([appId, key]), `config ${key}`, () =>
        config.configValue(appId, key),
      ),
  };
}

export function openScopedPids(pids: PidReader): PidReader {
  return {
    getActivePid: (input: PidInput) =>
      through(
        pids,
        JSON.stringify([
          input.appId,
          input.platform,
          input.pidScene,
          input.purpose,
          // B1-19d: the account filter is part of the key; unscoped reads key on null.
          input.unionAccountId ?? null,
        ]),
        `active pid ${input.platform}/${input.pidScene}`,
        () => pids.getActivePid(input),
      ),
  };
}

export function openScopedAttrCodes(
  attrCodes: AttrCodeReader | undefined,
): AttrCodeReader | undefined {
  if (attrCodes === undefined) return undefined;
  return {
    attrCode: (appId, userId) =>
      through(attrCodes, JSON.stringify([appId, userId]), 'attr_code', () =>
        attrCodes.attrCode(appId, userId),
      ),
  };
}

/** One identity an open may convert with (every outcome of the owner stage counted). */
export interface LinkOpenReadIdentity {
  readonly userId: string | null;
  readonly pidScene: string;
  readonly noRebate: boolean;
}

/** What an open's conversion may read, known before its transaction. */
export interface LinkOpenReadPlan {
  readonly appId: string;
  readonly platform: string;
  readonly identities: readonly LinkOpenReadIdentity[];
}

/**
 * B1-19d (BR-ATTR-02, BR-ATTR-07, BR-ID-17): the account-scoped slot reads an authorization may
 * make inside the open's transaction, pre-read for every union account of the platform in this
 * app (the account in use is only known from the binding read inside the transaction; one
 * account per platform is the default, BR-ATTR-02). A read-only select of union_accounts ids
 * scoped by app_id, as union-auth-reads.ts does; failures surface when the slot is read.
 */
export async function prepareAccountSlots(
  db: Kysely<DB>,
  pids: PidReader,
  input: {
    readonly appId: string;
    readonly platform: PidInput['platform'];
    readonly scenes: Iterable<string>;
  },
): Promise<void> {
  const { appId, platform } = input;
  const accounts = await db
    .selectFrom('union_accounts')
    .select('id')
    .where('app_id', '=', appId)
    .where('platform', '=', platform)
    .execute();
  const scenes = [...new Set(input.scenes)];
  await Promise.allSettled(
    accounts.flatMap((account) =>
      scenes.map((pidScene) =>
        pids.getActivePid({
          appId,
          platform,
          pidScene: pidScene as PidInput['pidScene'],
          purpose: 'convert',
          unionAccountId: account.id,
        }),
      ),
    ),
  );
}
