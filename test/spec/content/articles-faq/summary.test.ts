// F1-02zzp §9.3 ①：列表摘要只看正文本身（01 §4.2 Help；04 §6.2 summary；契约 ArticleListSummaryText
// 1–80 字）。对照值来自 ./faq-body.ts，不取 content 自己的常量；性质测试的次数与种子只来自
// @couli/testing。
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { articleListSummary } from '../../../../apps/api/src/modules/content/domain/article-summary.ts';
import {
  codePointLength,
  divider,
  doc,
  firstCodePoints,
  hardBreak,
  image,
  LINK_HREF,
  paragraph,
  text,
  type Mark,
  type TiptapNode,
} from './faq-body.ts';

const CJK = Array.from({ length: 100 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');

it('[AC-F1-02zzp#1] 取首个非空文字段落：跳过图片、分隔线、空段落与只有空白的段落', () => {
  const body = doc(
    image(),
    divider(),
    paragraph(),
    paragraph(text('  　\t ')),
    paragraph(text('第一段说明')),
    paragraph(text('第二段不进摘要')),
  );
  expect(articleListSummary(body)).toBe('第一段说明');
  expect(articleListSummary(doc(paragraph(text('只有一段'))))).toBe('只有一段');
});

it('[AC-F1-02zzp#2] 加粗、斜体、链接只取文字，不带链接地址、标记名或 JSON', () => {
  const body = doc(
    paragraph(
      text('先领券', [{ type: 'bold' }]),
      text('再下单', [{ type: 'link', attrs: { href: LINK_HREF } }]),
      text('，返利到账', [{ type: 'italic' }, { type: 'bold' }]),
    ),
  );
  const summary = articleListSummary(body);
  expect(summary).toBe('先领券再下单，返利到账');
  expect(summary).not.toContain('example.test');
});

it.each([
  ['100 个中文', CJK, firstCodePoints(CJK, 80)],
  ['第 80 个字是 emoji', `${'a'.repeat(79)}😀${'b'.repeat(10)}`, `${'a'.repeat(79)}😀`],
  ['全是 emoji', '😀'.repeat(100), '😀'.repeat(80)],
  ['扩展区汉字', '𠮷'.repeat(81), '𠮷'.repeat(80)],
  ['正好 80 字', CJK.slice(0, 80), CJK.slice(0, 80)],
  ['79 字', `${CJK.slice(0, 78)}😀`, `${CJK.slice(0, 78)}😀`],
])('[AC-F1-02zzp#3] 截到 80 个码点（%s），不切坏代理对', (_name, value, expected) => {
  const summary = articleListSummary(doc(paragraph(text(value))));
  expect(summary).toBe(expected);
  expect(codePointLength(summary!)).toBeLessThanOrEqual(80);
  expect(summary!.isWellFormed()).toBe(true);
});

it('[AC-F1-02zzp#3] 截断跨多个文字节点时按拼接后的纯文本计数', () => {
  const tail = `${'中'.repeat(29)}😀${'尾'.repeat(10)}`;
  const body = doc(paragraph(text('a'.repeat(50), [{ type: 'bold' }]), text(tail)));
  expect(articleListSummary(body)).toBe(`${'a'.repeat(50)}${'中'.repeat(29)}😀`);
});

it.each([
  ['空文档', doc()],
  ['无 content 的文档', '{"type":"doc"}'],
  ['只有图片、分隔线与空白段落', doc(image(), divider(), paragraph(), paragraph(text('   ')))],
  ['纯文本旧正文', '纯文本正文（不是 JSON）'],
  ['空串', ''],
  ['坏 JSON', '{"type":"doc","content":['],
  ['JSON null', 'null'],
  ['JSON 数组', '[]'],
  ['JSON 数字', '42'],
  ['JSON 字符串', '"一段文字"'],
  ['content 不是数组', '{"type":"doc","content":"文字"}'],
  ['content 里不是节点', '{"type":"doc","content":[null,3,"文字"]}'],
])('[AC-F1-02zzp#4] %s：没有摘要（undefined），不抛错', (_name, body) => {
  expect(articleListSummary(body)).toBeUndefined();
});

it('[AC-F1-02zzp#5] hardBreak 处理由实现定但稳定：同一正文结果相同，只含段落文字', () => {
  const body = doc(
    paragraph(text('第一行'), hardBreak(), text('第二行')),
    paragraph(text('下一段')),
  );
  const first = articleListSummary(body);
  expect(first).toEqual(expect.any(String));
  expect(articleListSummary(body)).toBe(first);
  expect(first!.startsWith('第一行')).toBe(true);
  expect(first).not.toMatch(/hardBreak|[{}"]|下一段/);
  expect(codePointLength(first!)).toBeLessThanOrEqual(80);
});

// 非空段落的文字不含空白，空白只出现在「只有空白的段落」里，因此对照值不依赖是否修剪空白。
const charArb = fc.oneof(
  fc.constantFrom(...CJK.slice(0, 20)),
  fc.constantFrom('a', 'Z', '7', '，', '。', '%'),
  fc.constantFrom('😀', '🧧', '💰', '𠮷', '𩸽'),
);
const markArb: fc.Arbitrary<Mark[]> = fc.constantFrom<Mark[]>(
  [],
  [{ type: 'bold' }],
  [{ type: 'italic' }],
  [{ type: 'link', attrs: { href: LINK_HREF } }],
);
type Block =
  | { kind: 'image' }
  | { kind: 'divider' }
  | { kind: 'empty' }
  | { kind: 'blank'; value: string }
  | { kind: 'text'; segments: { value: string; marks: Mark[] }[] };
const blockArb: fc.Arbitrary<Block> = fc.oneof(
  fc.constantFrom<Block>({ kind: 'image' }, { kind: 'divider' }, { kind: 'empty' }),
  fc.constantFrom(' ', '　', '\t', '  　 ').map((value): Block => ({ kind: 'blank', value })),
  fc
    .array(
      fc.record({
        value: fc.string({ unit: charArb, minLength: 1, maxLength: 60 }),
        marks: markArb,
      }),
      { minLength: 1, maxLength: 4 },
    )
    .map((segments): Block => ({ kind: 'text', segments })),
);
function toNode(block: Block): TiptapNode {
  if (block.kind === 'image') return image();
  if (block.kind === 'divider') return divider();
  if (block.kind === 'empty') return paragraph();
  if (block.kind === 'blank') return paragraph(text(block.value));
  return paragraph(...block.segments.map((s) => text(s.value, s.marks)));
}
function oracle(blocks: readonly Block[]): string | undefined {
  for (const block of blocks) {
    if (block.kind === 'text')
      return firstCodePoints(block.segments.map((s) => s.value).join(''), 80);
  }
  return undefined;
}

const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

it(
  '[AC-F1-02zzp#6] 任意块序列：摘要等于首个非空段落纯文本的前 80 码点，没有则 undefined',
  () => {
    expect(() =>
      fc.assert(
        fc.property(fc.array(blockArb, { maxLength: 8 }), (blocks) => {
          const summary = articleListSummary(doc(...blocks.map(toNode)));
          const expected = oracle(blocks);
          if (expected === undefined) return summary === undefined;
          return (
            summary === expected &&
            summary.isWellFormed() &&
            codePointLength(summary) >= 1 &&
            codePointLength(summary) <= 80
          );
        }),
        propParams(),
      ),
    ).not.toThrow();
  },
  PROPERTY_TIMEOUT_MS,
);

it(
  '[AC-F1-02zzp#6] 任意字符串正文都不抛错；有摘要时 1–80 码点且无孤立代理',
  () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.oneof(fc.string({ unit: 'binary', maxLength: 200 }), fc.json({ maxDepth: 4 })),
          (body) => {
            const summary = articleListSummary(body);
            return (
              summary === undefined ||
              (summary.isWellFormed() &&
                codePointLength(summary) >= 1 &&
                codePointLength(summary) <= 80)
            );
          },
        ),
        propParams(),
      ),
    ).not.toThrow();
  },
  PROPERTY_TIMEOUT_MS,
);
