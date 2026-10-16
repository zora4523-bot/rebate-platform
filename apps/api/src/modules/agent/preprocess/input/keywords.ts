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

// BR-AI-18 / AI-15: only requests FOR advice are refused; a product search is not. The decision is
// per clause (split at ，。！？；、 and line breaks). A clause with an advice hit is a product
// search when, after the advice words themselves are taken out, it still shows a shopping intent
// and a product (a product noun anywhere, or a measure word followed by more text):
//   「帮我找一本讲怎么治疗失眠的书」「推荐几本投资建议类的书籍」 → product search, passes.
//   「失眠吃什么药」「这个合同有没有法律问题」「想要个法律建议」 → no product left, refused.
// The one exception is investment: a clause naming an investment target (股票, 基金, 币, 理财产品,
// 期货) together with a which / when-to-buy question, or with no reading material at all, is
// investment advice even with a shopping verb (「今天该买哪只股票」「推荐一只基金」).
const CLAUSE_END = /[，。！？；,.!?;、\n]/u;
const SHOPPING_INTENT = /帮我找|找一|找本|找个|找款|找|买|购|推荐|求购|有没有卖|想要|哪里能买|搜/u;
const PRODUCT_NOUN =
  /书|教材|教程|读物|课程|手册|杂志|绘本|资料|专著|器|仪|机|药盒|贴|垫|枕|灯|盒|包|套装/u;
/** A measure word counts as a product only when something follows it (「想要个」 alone does not). */
const MEASURE_WORD = /[本款个件台套只盒瓶支把双张][\p{Script=Han}A-Za-z0-9]/u;
const INVESTMENT_TARGET = /股票|基金|币|理财产品|期货/u;
const INVESTMENT_QUESTION = /买哪|买什么|该不该买|什么时候买|哪只|推荐一只|推荐一支/u;
const READING_MATERIAL = /书|教材|教程|读物|课程|杂志|专著/u;

function clauseAround(text: string, at: number, length: number): string {
  let start = at;
  while (start > 0 && !CLAUSE_END.test(text.charAt(start - 1))) start -= 1;
  let end = at + length;
  while (end < text.length && !CLAUSE_END.test(text.charAt(end))) end += 1;
  return text.slice(start, end);
}

function isProductSearchClause(clause: string, adviceWords: readonly string[]): boolean {
  if (INVESTMENT_TARGET.test(clause)) {
    if (INVESTMENT_QUESTION.test(clause) || !READING_MATERIAL.test(clause)) return false;
  }
  // Advice words go first, so their own characters (买入时机, 推荐股票) never count as intent or product.
  let rest = clause;
  for (const word of adviceWords) rest = rest.split(word).join('｜');
  return SHOPPING_INTENT.test(rest) && (PRODUCT_NOUN.test(rest) || MEASURE_WORD.test(rest));
}

function containsWord(
  text: string,
  word: string,
  exempt?: (text: string, at: number, word: string) => boolean,
): boolean {
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
  const productSearch = (text: string, at: number, word: string): boolean =>
    isProductSearchClause(clauseAround(text, at, word.length), groups.advice);
  return {
    hits: (group, text) =>
      groups[group].some((word) =>
        containsWord(text, word, group === 'advice' ? productSearch : undefined),
      ),
  };
}
