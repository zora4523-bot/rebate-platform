/** Numeric major/minor/patch comparison; null means malformed client version. */
export function compareClientVersions(
  version: string | undefined,
  minimum: string,
): -1 | 0 | 1 | null {
  void version;
  void minimum;
  throw new Error('NotImplemented: compareClientVersions');
}
