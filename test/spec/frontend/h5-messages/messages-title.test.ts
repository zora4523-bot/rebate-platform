// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { list, message, messagesServer, reply } from './messages-fixtures.ts';
import { mount, rowFor } from './messages-helpers.ts';

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const graphemes = (text: string): string[] =>
  Array.from(segmenter.segment(text), (part) => part.segment);
// In u-mode a paired surrogate is one code point, so these classes only match lone halves.
const LONE_SURROGATE = /[\u{D800}-\u{DBFF}\u{DC00}-\u{DFFF}]/u;
const ELLIPSIS = /(?:\u{2026}|\.{3})/u;

// Code points written as escapes so the source holds no invisible characters.
const ZWJ = '\u{200D}';
const ACUTE = '\u{301}';
const TILDE = '\u{303}';
const FAMILY = ['\u{1F468}', '\u{1F469}', '\u{1F467}', '\u{1F466}'].join(ZWJ);
const FLAG_CN = '\u{1F1E8}\u{1F1F3}';
const FLAG_JP = '\u{1F1EF}\u{1F1F5}';
const CODER = `\u{1F469}\u{1F3FD}${ZWJ}\u{1F4BB}`;

/**
 * Smallest element inside the row whose text starts with the title's first graphemes (the
 * rendered, possibly shortened title), and its own text: direct text nodes only, so a visually
 * hidden 「未读」 or a separately styled ellipsis inside it does not count as title text.
 */
function renderedTitle(row: HTMLElement, title: string): { element: HTMLElement; text: string } {
  const head = graphemes(title).slice(0, 2).join('');
  const candidates = [row, ...Array.from(row.querySelectorAll<HTMLElement>('*'))].filter(
    (element) =>
      (element.textContent ?? '').startsWith(head) &&
      !Array.from(element.children).some((child) => (child.textContent ?? '').startsWith(head)),
  );
  expect(candidates.length, '行内应有一个以标题开头的元素').toBeGreaterThan(0);
  const element = candidates[0]!;
  const text = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join('');
  return { element, text };
}

/** Shown text without the ellipsis must be exactly the first k graphemes of the title. */
function expectGraphemePrefix(shown: string, title: string): number {
  const kept = shown.replace(/(?:\u{2026}|\.{3})\s*$/u, '').trimEnd();
  const all = graphemes(title);
  const parts = graphemes(kept);
  expect(parts.length).toBeGreaterThan(0);
  expect(parts).toEqual(all.slice(0, parts.length));
  expect(shown).not.toMatch(LONE_SURROGATE);
  return parts.length;
}

// 每个单元由多种字素组成：汉字（1 码元）、ZWJ 家庭表情（11 码元）、旗帜（4）、e + 组合重音（2）。
const UNIT = `订单${FAMILY}${FLAG_CN}e${ACUTE}`;
const LONG_TITLE = `${UNIT.repeat(40)}结束`;

it('[AC-F1-04c-TITLE#1] 超长标题按字素截断并加省略号：不拆表情、旗帜与组合字符', async () => {
  const body = '超长标题消息的正文';
  const http = messagesServer({
    list: () => reply(list([message({ title: LONG_TITLE, body })])),
  });
  mount(http.api);
  await screen.findByText(body, { exact: false });
  const { element, text } = renderedTitle(rowFor(body), LONG_TITLE);
  expect(element.textContent).toMatch(ELLIPSIS);
  const kept = expectGraphemePrefix(text, LONG_TITLE);
  expect(kept).toBeLessThan(graphemes(LONG_TITLE).length);
});

it('[AC-F1-04c-TITLE#2] 截断点落在多码元字素前后的各种位置，都不产生半个字素', async () => {
  // 前缀 0–7 个汉字，使按码元计的截断点分别落进肤色 ZWJ 序列、旗帜与组合字符之内。
  const tail = `${CODER}${FLAG_JP}n${TILDE}`;
  const titles = Array.from({ length: 8 }, (_, index) => '消'.repeat(index) + tail.repeat(30));
  const items = titles.map((title, index) => message({ title, body: `截断样例正文 ${index}` }));
  const http = messagesServer({ list: () => reply(list(items)) });
  mount(http.api);
  await screen.findByText('截断样例正文 0', { exact: false });
  titles.forEach((title, index) => {
    const { element, text } = renderedTitle(rowFor(`截断样例正文 ${index}`), title);
    expect(element.textContent).toMatch(ELLIPSIS);
    expect(expectGraphemePrefix(text, title)).toBeLessThan(graphemes(title).length);
  });
});

it('[AC-F1-04c-TITLE#3] 短标题（含表情与组合字符）原样完整显示，不加省略号', async () => {
  const title = `提现到账\u{1F389} cafe${ACUTE}`;
  const body = '短标题消息的正文';
  const http = messagesServer({ list: () => reply(list([message({ title, body })])) });
  mount(http.api);
  await screen.findByText(body, { exact: false });
  const { element, text } = renderedTitle(rowFor(body), title);
  expect(text.trim()).toBe(title);
  expect(element.textContent).not.toMatch(ELLIPSIS);
});
