// The config_items values as read and the report channel shared by the /v1/config derivations
// (client-config.ts, invite-eligibility.ts). Kept apart so neither imports the other in a cycle.
//
// Also compiled by the `test` project: erasable syntax only.

/** Values as read: a key that has no config_items row is absent from the map. */
export type ConfigValues = ReadonlyMap<string, unknown>;

export interface ConfigReport {
  /** A required key is absent or of the wrong shape: the response fails. */
  missing(key: string): void;
  /** An optional key has the wrong shape: its default is used. */
  invalid(key: string): void;
}
