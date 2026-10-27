// B3-08i 切块 (ledger notes; 02 §9.2 规则 RAG; BR-AI-07 T6 rule_ref excerpt ≤ 200 字, shown as is):
// paragraph by paragraph, each chunk ≤ 200 characters (code points, as char_length in
// agent_rule_chunks_text_check); an over-long paragraph is cut again at 。 or a line break, a
// piece still over 200 is cut hard; chunk title is the article title, seq counts from 0. The body
// is the stored tiptap JSON (F1-02m): every textblock (paragraph, heading, also inside lists and
// quotes) is a paragraph; marks do not split; nodes without text yield nothing.
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  chunkArticle,
  type RuleChunkDraft,
} from '../../../../apps/api/src/modules/agent/rag/chunks/index.ts';
import {
  BR,
  IMAGE,
  MAX_CHARS,
  RULE,
  TITLE,
  blockquote,
  bodyOf,
  bulletList,
  codePoints,
  doc,
  heading,
  orderedList,
  paragraph,
  text,
  wellFormed,
  type Node,
} from './kit.ts';

function texts(drafts: readonly RuleChunkDraft[]): string[] {
  return drafts.map((draft) => draft.text);
}

function cut(body: string, title: string = TITLE): string[] {
  const drafts = chunkArticle({ title, body });
  expect(drafts.map((draft) => draft.seq)).toEqual(drafts.map((_, index) => index));
  expect(new Set(drafts.map((draft) => draft.title))).toEqual(
    drafts.length === 0 ? new Set() : new Set([title]),
  );
  return texts(drafts);
}

it('[AC-B3-08i#1][BR-AI-07] 每个段落各成一块：块标题取文章标题，seq 从 0 递增；不超长的段落原样成块，不与相邻段落合并，也不按句号再切', () => {
  const body = doc(
    paragraph('确认收货后返利进入待结算。'),
    paragraph('结算后可在钱包申请提现。提现一个工作日内到账。'),
    paragraph('如有疑问请联系客服。'),
  );
  expect(chunkArticle({ title: TITLE, body })).toEqual([
    { seq: 0, title: TITLE, text: '确认收货后返利进入待结算。' },
    { seq: 1, title: TITLE, text: '结算后可在钱包申请提现。提现一个工作日内到账。' },
    { seq: 2, title: TITLE, text: '如有疑问请联系客服。' },
  ]);
  expect(chunkArticle({ title: '提现规则', body: bodyOf('单笔最低 1 元。') })).toEqual([
    { seq: 0, title: '提现规则', text: '单笔最低 1 元。' },
  ]);
});

it('[AC-B3-08i#2][BR-AI-07] 正文是 tiptap JSON：标题、列表项（含嵌套）与引用里的段落各算一段并按文中顺序成块；加粗 / 斜体不拆段；分隔线、图片、空段落不成块；没有文字的正文切出 0 块', () => {
  const body = doc(
    heading(2, '提现说明'),
    paragraph('满', text('10 元', 'bold'), text('可提现', 'italic'), '。'),
    RULE,
    paragraph(),
    paragraph(IMAGE),
    bulletList([paragraph('支付宝')], [paragraph('银行卡'), bulletList([paragraph('仅限本人')])]),
    orderedList([paragraph('先完成实名')]),
    blockquote(paragraph('以页面展示为准。')),
  );
  expect(cut(body)).toEqual([
    '提现说明',
    '满10 元可提现。',
    '支付宝',
    '银行卡',
    '仅限本人',
    '先完成实名',
    '以页面展示为准。',
  ]);
  expect(cut(doc(paragraph(), paragraph(IMAGE), RULE))).toEqual([]);
});

it('[AC-B3-08i#3][BR-AI-07] 超过 200 字的段落按句号再切：每块不超过 200 字、都以句号结尾、按序拼回即原段落；单句仍超长时只在这一句里硬切', () => {
  const sentences = ['甲'.repeat(99) + '。', '乙'.repeat(99) + '。', '丙'.repeat(99) + '。'];
  const long = sentences.join('');
  const got = cut(bodyOf(long));
  expect(got.join('')).toBe(long);
  expect(got.length).toBeGreaterThanOrEqual(2);
  for (const piece of got) {
    expect(codePoints(piece)).toBeLessThanOrEqual(MAX_CHARS);
    expect(piece).toMatch(/^(?:[^。]+。)+$/u);
  }

  const short = '甲'.repeat(49) + '。';
  const overlong = '乙'.repeat(250) + '。';
  const expected = [short, '乙'.repeat(200), '乙'.repeat(50) + '。'];
  expect(cut(bodyOf(short + overlong))).toEqual(expected);
});

it('[AC-B3-08i#4][BR-AI-07] 超过 200 字的段落按换行（hardBreak）再切：切点落在换行处，两行各成一块', () => {
  const first = '甲'.repeat(120);
  const second = '乙'.repeat(120);
  const got = cut(doc(paragraph(first, BR, second)));
  expect(got.map((piece) => piece.trim())).toEqual([first, second]);
  for (const piece of got) expect(codePoints(piece)).toBeLessThanOrEqual(MAX_CHARS);
});

it('[AC-B3-08i#5][BR-AI-07] 没有句号与换行的超长段落按 200 字硬切：恰 200 字不切、201 字切成 200 + 1；字数按码点计，不拆开代理对', () => {
  expect(cut(bodyOf('规'.repeat(200)))).toEqual(['规'.repeat(200)]);
  expect(cut(bodyOf('规'.repeat(201)))).toEqual(['规'.repeat(200), '规']);
  expect(cut(bodyOf('规'.repeat(450)))).toEqual([
    '规'.repeat(200),
    '规'.repeat(200),
    '规'.repeat(50),
  ]);
  // U+20000 is one character (code point) but two UTF-16 units.
  const wide = '\u{20000}';
  expect(cut(bodyOf(wide.repeat(300)))).toEqual([wide.repeat(200), wide.repeat(100)]);
  const mixed = cut(bodyOf(wide.repeat(150) + '规'.repeat(100)));
  expect(mixed).toEqual([wide.repeat(150) + '规'.repeat(50), '规'.repeat(50)]);
  for (const piece of mixed) expect(wellFormed(piece)).toBe(true);
});

// ---- property ------------------------------------------------------------------------------

/** A text segment, or 'BR' for a hardBreak. */
type Part = string;
/** One generated block: a paragraph (parts) or an empty paragraph (null). */
type Block = readonly Part[] | null;

const SPACE = /\s/gu;

function nodeOf(block: Block): Node {
  if (block === null) return paragraph();
  return paragraph(...block.map((part) => (part === 'BR' ? BR : part)));
}

/** A paragraph's characters, whitespace and line breaks left out (cuts may drop them). */
function stripped(block: Block): string {
  if (block === null) return '';
  return block
    .filter((part) => part !== 'BR')
    .join('')
    .replace(SPACE, '');
}

function attempt(blocks: readonly Block[], title: string): readonly RuleChunkDraft[] | string {
  try {
    return chunkArticle({ title, body: doc(...blocks.map(nodeOf)) });
  } catch (error) {
    return `threw: ${String(error)}`;
  }
}

function holds(blocks: readonly Block[], title: string): boolean {
  const got = attempt(blocks, title);
  if (typeof got === 'string') return false;
  for (const [index, draft] of got.entries()) {
    if (Object.keys(draft).sort().join(',') !== 'seq,text,title') return false;
    if (draft.seq !== index || draft.title !== title) return false;
    if (draft.text.trim() === '' || codePoints(draft.text) > MAX_CHARS) return false;
    if (!wellFormed(draft.text)) return false;
  }
  // Paragraphs in order, each covered by whole chunks: no chunk spans two paragraphs, nothing is
  // lost or invented.
  let at = 0;
  for (const want of blocks.map(stripped).filter((value) => value !== '')) {
    let covered = '';
    while (covered.length < want.length) {
      const next = got[at];
      if (next === undefined) return false;
      covered += next.text.replace(SPACE, '');
      at += 1;
    }
    if (covered !== want) return false;
  }
  return at === got.length;
}

// U+20000 and the emoji are outside the BMP (two UTF-16 units, one character).
const CHARS = ['规', '则', '返', '利', '。', '，', 'a', '1', ' ', '\u{20000}', '🎧'];
const piece = fc.constantFrom(...CHARS);
const segment = fc.array(piece, { minLength: 1, maxLength: 100 }).map((parts) => parts.join(''));
const part: fc.Arbitrary<Part> = fc.oneof(
  { weight: 4, arbitrary: segment },
  { weight: 1, arbitrary: fc.constant('BR') },
);
// Every non-empty paragraph starts with a character, so none is whitespace only.
const filled = fc
  .array(part, { minLength: 1, maxLength: 6 })
  .map((parts): readonly Part[] => ['段', ...parts]);
const block: fc.Arbitrary<Block> = fc.oneof(
  { weight: 5, arbitrary: filled },
  { weight: 1, arbitrary: fc.constant(null) },
);
const blocks = fc.array(block, { maxLength: 6 });
const title = fc.constantFrom(TITLE, '提现规则');

const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

it(
  '[AC-B3-08i#6][BR-AI-07] 任意段落组合（中文、句号、空格、换行、码点外字符）：每块非空白、不超过 200 个码点、无孤立代理项，seq 依次、标题取文章标题；块按文中顺序恰好铺满各段文字，不跨段、不丢字、不造字',
  () => {
    const details = fc.check(
      fc.property(blocks, title, (b, t) => holds(b, t)),
      propParams(),
    );
    const counterexample =
      details.counterexample === null
        ? null
        : {
            blocks: details.counterexample[0],
            title: details.counterexample[1],
            got: attempt(details.counterexample[0], details.counterexample[1]),
          };
    expect({ failed: details.failed, counterexample }).toStrictEqual({
      failed: false,
      counterexample: null,
    });
  },
  PROPERTY_TIMEOUT_MS,
);
