import type { LinkPatternsSpec, MaterialChannelsSpec } from '../../../../platform/index.ts';

export interface PageValidationContext {
  readonly unionHostBlock: boolean;
  readonly linkPatterns: LinkPatternsSpec;
  readonly routeNames: ReadonlySet<string>;
  readonly materialChannels: MaterialChannelsSpec;
}

/** 通过返回 []；否则返回 data.fields（去重，按遍历顺序）。 */
export function validatePageSections(sections: unknown, context: PageValidationContext): string[] {
  void sections;
  void context;
  throw new Error('NotImplemented: validatePageSections');
}
