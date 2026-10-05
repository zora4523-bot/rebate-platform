/**
 * Build-time renderer: read the supplied YAML file and emit link-patterns.gen.ts source,
 * exporting LINK_PATTERNS. An explicit input lets rule tests use synthetic specifications.
 */
export async function linkPatternsSource(inputFile: URL): Promise<string> {
  void inputFile;
  throw new Error('NotImplemented: linkPatternsSource');
}
