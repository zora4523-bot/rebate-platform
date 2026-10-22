export interface TrimTextDictionary {
  texts: Record<string, string>;
  fallbacks: Record<string, string>;
}

export interface CollectH5TextsOptions {
  /** Absolute src directory; scan the entire tree, including all entries and lazy routes. */
  sourceRoot: string;
  /** Caller-owned input, including future contract additions; never mutate it. */
  dictionary: TrimTextDictionary;
}

/**
 * Build-time seam: collect literal references and explicitly registered dynamic uses across
 * sourceRoot, retaining their texts and fallbacks. Reject uncovered nonliteral translation
 * arguments, including variables and wrapper calls. Registration syntax is an implementation
 * choice. The Vite plugin replaces the contract dictionary only during builds; without the
 * plugin (including Vitest), shared/texts.ts must still load the complete contract dictionary.
 * For build inspection, emit trim-texts.json containing the same { texts, fallbacks } object
 * used for replacement, for every entry (even if tree-shaking removes its dictionary module).
 */
export function collectH5Texts(options: CollectH5TextsOptions): TrimTextDictionary {
  void options;
  throw new Error('NotImplemented: collectH5Texts');
}
