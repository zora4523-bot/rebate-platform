// B3-05d · BR-AI-18: the advice pre-check and the prohibited query words on the user's own text.
// The lists mirror specs/agent-input-keywords.yaml (a rule test compares them); the runtime never
// reads the file. Change both together.

export interface InputKeywordLists {
  readonly advice: readonly string[];
  readonly prohibited: readonly string[];
}

/** Fresh copy each call; the matcher below is built from the same call. */
export function inputKeywordLists(): InputKeywordLists {
  return {
    advice: [
      '是什么病',
      '得了什么病',
      '帮我诊断',
      '诊断一下',
      '怎么治疗',
      '如何治疗',
      '治疗方案',
      '要不要去医院',
      '吃什么药',
      '用什么药',
      '多少剂量',
      '用药剂量',
      '服用剂量',
      '一次吃几片',
      '一次吃多少',
      '法律建议',
      '法律意见',
      '法律咨询',
      '怎么起诉',
      '如何起诉',
      '官司怎么打',
      '能不能告他',
      '投资建议',
      '理财建议',
      '哪只股票',
      '推荐股票',
      '推荐一只基金',
      '买什么基金',
      '买入时机',
      '卖出时机',
      '该不该抄底',
    ],
    prohibited: [
      '处方药',
      '烟草',
      '香烟',
      '卷烟',
      '雪茄',
      '电子烟',
      '烟弹',
      '成人用品',
      '情趣用品',
      '二类医疗器械',
      '三类医疗器械',
      '彩票',
      '虚拟币',
      '加密货币',
      '比特币',
      '枪械',
      '枪支',
      '仿真枪',
      '弹药',
      '管制刀具',
      '匕首',
    ],
  };
}

/** NFKC, whitespace removed: 「吃 什么 药」 and full-width forms match the same entry. */
export function normalizeForKeywords(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '');
}

export type KeywordGroup = keyof InputKeywordLists;

export interface KeywordMatcher {
  /** `text` must already be normalized with normalizeForKeywords. */
  hits(group: KeywordGroup, text: string): boolean;
}

// A hit right after 「非」 is a negation (「非处方药」 is a product search, not 「处方药」).
const NEGATION = '非';

function containsWord(text: string, word: string): boolean {
  let at = text.indexOf(word);
  while (at !== -1) {
    if (at === 0 || text[at - 1] !== NEGATION) return true;
    at = text.indexOf(word, at + 1);
  }
  return false;
}

export function createKeywordMatcher(lists: InputKeywordLists): KeywordMatcher {
  const groups: Record<KeywordGroup, readonly string[]> = {
    advice: lists.advice.map(normalizeForKeywords).filter((word) => word.length > 0),
    prohibited: lists.prohibited.map(normalizeForKeywords).filter((word) => word.length > 0),
  };
  return {
    hits: (group, text) => groups[group].some((word) => containsWord(text, word)),
  };
}
