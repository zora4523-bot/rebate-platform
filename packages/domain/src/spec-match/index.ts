/** BR-AI-24: 同义单位归一，不做升/毫升、千克/克之间的换算。 */
export type SpecUnit = 'ml' | 'L' | 'g' | 'kg' | '盒' | '箱' | '袋' | '瓶' | '包' | '件';

/** 数值用十进制字符串保存；多规格按输入出现顺序保存。 */
export type NormalizedSpec = readonly { readonly value: string; readonly unit: SpecUnit }[];

export function normalizeSpec(text: string): NormalizedSpec | null {
  void text;
  throw new Error('NotImplemented: normalizeSpec');
}

/** 返回标题 NFKC 后的匹配片段，去掉空白；所有规格均命中才返回。 */
export function findSpecInTitle(spec: string, title: string): string | null {
  void spec;
  void title;
  throw new Error('NotImplemented: findSpecInTitle');
}
