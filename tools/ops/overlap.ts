// Conservative overlap test between glob lists (规划/11 §2.2: tasks whose
// `paths` intersect are never in flight together).
//
// Deciding whether two globs can match a common path is not worth an exact
// algorithm here. Each glob is reduced to its literal prefix (everything before
// the first wildcard); two globs may overlap when one prefix is a prefix of the
// other. This never misses a real overlap; it can report one that does not
// exist (`a/*.ts` vs `a/*.md`), which only delays a dispatch.

const WILDCARD = /[*?{[]/;

export function literalPrefix(glob: string): string {
  const at = glob.search(WILDCARD);
  return at < 0 ? glob : glob.slice(0, at);
}

export function globsMayOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

export function pathSetsMayOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => globsMayOverlap(x, y)));
}

/** Directory part of the literal prefix, without a trailing slash ('' = repo root). */
export function literalDir(glob: string): string {
  const prefix = literalPrefix(glob);
  if (prefix === glob) {
    // No wildcard: a file path (or a directory written without a trailing slash).
    const cut = glob.lastIndexOf('/');
    return cut < 0 ? '' : glob.slice(0, cut);
  }
  const cut = prefix.lastIndexOf('/');
  return cut < 0 ? '' : prefix.slice(0, cut);
}
