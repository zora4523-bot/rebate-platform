// F1-02zzj (D10-281, D10-152 ④): config_items keys written only through a dedicated content
// port. The general configuration center (admin list / get / versions / update / batch /
// rollback), the switch registry and GET /v1/config never return or accept them, and they are
// never entries of config-registry. Shared readers (ContentReader) still read them.
//
// Also compiled by the `test` project: erasable syntax only.

/** The dedicated keys; today only the station-owner alert phones (written by union). */
export type DedicatedConfigKey = 'union.auth_alert_phones';

const KEYS: readonly DedicatedConfigKey[] = Object.freeze(['union.auth_alert_phones']);
const SET: ReadonlySet<string> = new Set<string>(KEYS);

/** Every dedicated key, in a fixed order. */
export function dedicatedConfigKeys(): readonly DedicatedConfigKey[] {
  return KEYS;
}

/** Whether `key` is written only through a dedicated port (hidden from general outlets). */
export function isDedicatedConfigKey(key: string): key is DedicatedConfigKey {
  return SET.has(key);
}
