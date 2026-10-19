// Identity's labor agreement port for withdrawals (规划/08 BR-WDR-31, BR-WDR-03 ⑥a 10004
// data.consent_type=labor_agreement, GET /v1/withdrawals/rules; task B1-13h §9.2 #8): whether the
// user's signature still counts, i.e. GET /v1/me/labor-agreement need_sign=false. Same reads and
// rule as the GET (domain/labor-agreement.ts signingState):
// - the caller's handle only (a transaction included, also READ ONLY; an uncommitted signature of
//   that transaction is seen), uncached, never writes, never borrows a second connection;
// - scoped to (app_id, user_id): only that user's user-level labor_agreement records of that app;
// - configuration through LaborAgreementConfigReader, the port app.module assembles (content's
//   reader bound to the caller's handle, as B1-11d's inviteBinderDeps): identity never reads
//   config_items itself. IdentityModule registers the assembled reader for this function when its
//   labor agreement provider is built (the exported signature takes no reader);
// - the configuration keys are read as one committed state (consistentConfigValues), whatever the
//   isolation level of the caller's transaction;
// - no reader assembled, a missing or malformed agreement configuration, or one that kept changing
//   while read, rejects (the message names the key only), never "signed" nor "not signed": the
//   caller answers 50001.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  AGREEMENT_CONFIG_KEYS,
  parseLaborAgreementConfig,
  signingState,
} from '../domain/labor-agreement.ts';
import { currentLaborAgreementRecord } from '../infra/labor-agreements.ts';

/**
 * Business configuration by app and key, read on the caller's handle (connection or transaction):
 * no second pooled connection, no cache (content implements it; app.module assembles it).
 */
export interface LaborAgreementConfigReader {
  configValue(
    appId: string,
    key: string,
    handle: Kysely<DB>,
  ): Promise<{ readonly value: unknown; readonly version: number } | null>;
}

let assembledReader: LaborAgreementConfigReader | null = null;

/** Called by IdentityModule with the reader app.module assembled (null: none). */
export function registerLaborAgreementConfigReader(
  reader: LaborAgreementConfigReader | null,
): void {
  assembledReader = reader;
}

/** Passes over the keys before a read that keeps changing is given up (each pass reads every key). */
export const MAX_CONFIG_PASSES = 4;

type ConfigEntry = { readonly value: unknown; readonly version: number } | null;

/** Same row state: same presence, same config_items.version and the same JSON value. */
function sameEntry(a: ConfigEntry, b: ConfigEntry): boolean {
  if (a === null || b === null) return a === b;
  return a.version === b.version && JSON.stringify(a.value) === JSON.stringify(b.value);
}

async function readPass(
  reader: LaborAgreementConfigReader,
  handle: Kysely<DB>,
  appId: string,
  keys: readonly string[],
): Promise<ConfigEntry[]> {
  const entries: ConfigEntry[] = [];
  // One after another: a transaction handle runs one statement at a time anyway.
  for (const key of keys) entries.push(await reader.configValue(appId, key, handle));
  return entries;
}

/**
 * key → value of the keys configured for the app (absent keys are missing), as ONE committed state
 * (Codex money r1 S1: a publication that changes version, URL and digest in one transaction must
 * never be read half old, half new). The reader answers one key per statement, so under READ
 * COMMITTED two keys may come from different commits. Every key is therefore read again until two
 * consecutive passes agree on every key (presence, config_items.version, value). config_items.version
 * only grows, so agreement means no commit touched any of the keys between its two reads; all of
 * them held these values at the moment between the passes: a real, consistent state. Under
 * REPEATABLE READ the second pass agrees at once. Still changing after MAX_CONFIG_PASSES passes →
 * { ok: false } (the caller answers 50001 or rejects), never a mixed set.
 */
export async function consistentConfigValues(
  reader: LaborAgreementConfigReader,
  handle: Kysely<DB>,
  appId: string,
  keys: readonly string[],
): Promise<{ readonly ok: true; readonly values: Map<string, unknown> } | { readonly ok: false }> {
  let previous = await readPass(reader, handle, appId, keys);
  for (let pass = 2; pass <= MAX_CONFIG_PASSES; pass += 1) {
    const current = await readPass(reader, handle, appId, keys);
    if (current.every((entry, index) => sameEntry(entry, previous[index] ?? null))) {
      const values = new Map<string, unknown>();
      current.forEach((entry, index) => {
        const key = keys[index];
        if (entry !== null && key !== undefined) values.set(key, entry.value);
      });
      return { ok: true, values };
    }
    previous = current;
  }
  return { ok: false };
}

/** Read-only withdrawal prerequisite; equivalent to GET need_sign=false, scoped to the app/user. */
export async function laborAgreementSigned(
  handle: Kysely<DB>,
  subject: { readonly app_id: string; readonly user_id: string },
): Promise<boolean> {
  const reader = assembledReader;
  if (reader === null) {
    throw new Error('identity: no labor agreement configuration reader is assembled');
  }
  const read = await consistentConfigValues(reader, handle, subject.app_id, AGREEMENT_CONFIG_KEYS);
  if (!read.ok) throw new Error('identity: labor agreement configuration kept changing while read');
  const config = parseLaborAgreementConfig(read.values);
  if (!config.ok) {
    throw new Error(`identity: labor agreement configuration missing or malformed (${config.key})`);
  }
  const record = await currentLaborAgreementRecord(handle, subject);
  return !signingState(record, config.value).need_sign;
}
