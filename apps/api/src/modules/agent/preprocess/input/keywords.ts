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
      '有没有法律问题',
      '有没有法律风险',
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
    // F-PROD-08 禁售黑名单逐类：处方药、烟草电子烟、成人用品、二类及以上医疗器械、彩票、虚拟币、
    // 枪械刀具。「刀具」按清单原文整词拦截，「厨房刀具」「刀具架」也会拒答（清单写的是刀具，不分用途；
    // 放宽须先改 08）。器械只拦类别写法，不列具体器械名（血压计等按找货，由结果层类目黑名单过滤）。
    prohibited: [
      '处方药',
      '烟草',
      '香烟',
      '卷烟',
      '雪茄',
      '烟丝',
      '烟油',
      '电子烟',
      '烟弹',
      '成人用品',
      '情趣用品',
      '情趣内衣',
      '二类医疗器械',
      '三类医疗器械',
      '第二类医疗器械',
      '第三类医疗器械',
      'Ⅱ类医疗器械',
      'Ⅲ类医疗器械',
      '彩票',
      '双色球',
      '大乐透',
      '虚拟币',
      '虚拟货币',
      '加密货币',
      '数字货币',
      '比特币',
      '以太坊',
      '泰达币',
      'usdt',
      '枪械',
      '枪支',
      '仿真枪',
      '猎枪',
      '弹药',
      '刀具',
      '管制刀具',
      '匕首',
      '弹簧刀',
      '军刺',
    ],
  };
}

/** NFKC, lower-cased, whitespace removed: 「吃 什么 药」, 「USDT」 and full-width forms match. */
export function normalizeForKeywords(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

export type KeywordGroup = keyof InputKeywordLists;

export interface KeywordMatcher {
  /** `text` must already be normalized with normalizeForKeywords. */
  hits(group: KeywordGroup, text: string): boolean;
}

// A hit right after 「非」 is a negation (「非处方药」 is a product search, not 「处方药」).
const NEGATION = '非';

// BR-AI-18 / AI-15: only requests FOR advice are refused; a product search is not (「帮我找法律咨询
// 方面的书」 is a book search). An advice hit is a product search when, in the same clause, a
// shopping verb comes before it and a product noun follows it right away. Questions such as
// 「今天该买哪只股票」「告诉我买入时机」 have no product noun after the hit and stay refused.
const CLAUSE_END = /[，。！？；,.!?;、\n]/u;
const SHOPPING_VERB = /找|买|购|推荐|有没有卖|想要|要一?本|来一?本|搜/u;
const PRODUCT_AFTER =
  /^(?:方面|相关|类|之类|主题|专业)?的?(?:书|书籍|图书|教材|教程|读物|课程|手册|杂志|绘本|资料|工具书|入门书|专著)/u;

function clauseAround(text: string, at: number, length: number): { start: number; end: number } {
  let start = at;
  while (start > 0 && !CLAUSE_END.test(text.charAt(start - 1))) start -= 1;
  let end = at + length;
  while (end < text.length && !CLAUSE_END.test(text.charAt(end))) end += 1;
  return { start, end };
}

function isProductSearch(text: string, at: number, word: string): boolean {
  const { start, end } = clauseAround(text, at, word.length);
  return (
    SHOPPING_VERB.test(text.slice(start, at)) &&
    PRODUCT_AFTER.test(text.slice(at + word.length, end))
  );
}

function containsWord(text: string, word: string, exempt?: typeof isProductSearch): boolean {
  let at = text.indexOf(word);
  while (at !== -1) {
    const negated = at > 0 && text[at - 1] === NEGATION;
    if (!negated && exempt?.(text, at, word) !== true) return true;
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
    hits: (group, text) =>
      groups[group].some((word) =>
        containsWord(text, word, group === 'advice' ? isProductSearch : undefined),
      ),
  };
}
