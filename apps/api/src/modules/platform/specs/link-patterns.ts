/** Runtime snapshot of specs/link-patterns.yaml; generation preserves every field and order. */
export interface LinkPatternsSpec {
  readonly version: string;
  readonly rules: readonly {
    readonly platform: string;
    readonly category: 'product' | 'promo' | 'union_host';
    readonly hosts: readonly string[];
    readonly path_patterns: readonly string[];
  }[];
}

/** Read the generated snapshot without loading YAML at runtime. */
export function getLinkPatterns(): LinkPatternsSpec {
  throw new Error('NotImplemented: getLinkPatterns');
}
