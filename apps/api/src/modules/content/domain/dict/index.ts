/** The first dot separates the dictionary name from the complete, possibly empty code. */
export function splitDictKey(key: string): { dict: string; code: string } {
  void key;
  throw new Error('NotImplemented: splitDictKey');
}

/**
 * Preserve string config values; missing/non-string values use the config sentinel "0".
 * Only canonical decimal positive int32 strings have a readable dictionary version.
 */
export function parseDictVersion(value: unknown): { version: string; limit: number | null } {
  void value;
  throw new Error('NotImplemented: parseDictVersion');
}
