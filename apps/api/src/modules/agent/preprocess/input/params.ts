// B3-05d · BR-AI-01 「页面引导」 input source ②: parameter writing and order / ID identifiers.
// The patterns mirror specs/agent-page-guide-params.yaml (a rule test compares them); the runtime
// never reads the file. Change both together.

/** YAML 保存正则源字符串，不保存 RegExp 对象；匹配用户原文中的参数与标识。 */
export interface PageGuideParamPatterns {
  readonly patterns: readonly string[];
}

/** Fresh copy each call; each source compiles with the `u` flag only. */
export function pageGuideParamPatterns(): PageGuideParamPatterns {
  return {
    patterns: [
      '\\p{L}[\\p{L}\\p{N}_]*\\s*[=＝]\\s*[^\\s=＝]',
      '(?:\\p{L}[\\p{L}\\p{N}_]*:|[A-Za-z_][A-Za-z0-9_]*：)\\s*[^\\s:：]',
      '(?:单号|编号|流水号)\\s*[:：]?\\s*(?=[A-Za-z0-9-]*\\d)[A-Za-z0-9-]{4,}',
      '(?<![A-Za-z])[Ii][Dd]\\s*[:：]?\\s*(?=[A-Za-z0-9-]*\\d)[A-Za-z0-9-]{4,}',
      '(?<!\\d)\\d{11,}(?!\\d)',
    ],
  };
}

export interface ParamDetector {
  /** True when any pattern matches the text (links and passwords already removed). */
  test(text: string): boolean;
}

export function createParamDetector(spec: PageGuideParamPatterns): ParamDetector {
  // Non-global, so `test` keeps no lastIndex state between runs.
  const compiled = spec.patterns.map((source) => new RegExp(source, 'u'));
  return { test: (text) => compiled.some((pattern) => pattern.test(text)) };
}
