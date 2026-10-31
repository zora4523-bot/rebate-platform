// F1-02zzp：tiptap 正文构造与摘要的独立对照（01 §4.2 Help：首个非空段落 → 纯文本 → 截 80 字）。
// 不依赖 content 的实现；单测与集成测试共用。
export type TiptapNode = Record<string, unknown>;
export type Mark =
  { type: 'bold' } | { type: 'italic' } | { type: 'link'; attrs: { href: string } };

export const MEDIA_IMAGE = 'https://media.example.test/assets/cover.png';
export const LINK_HREF = 'https://www.example.test/guide';

export function text(value: string, marks: readonly Mark[] = []): TiptapNode {
  return marks.length === 0 ? { type: 'text', text: value } : { type: 'text', text: value, marks };
}
export function paragraph(...content: TiptapNode[]): TiptapNode {
  return content.length === 0 ? { type: 'paragraph' } : { type: 'paragraph', content };
}
export function image(): TiptapNode {
  return { type: 'image', attrs: { src: MEDIA_IMAGE } };
}
export function divider(): TiptapNode {
  return { type: 'horizontalRule' };
}
export function hardBreak(): TiptapNode {
  return { type: 'hardBreak' };
}
export function doc(...content: TiptapNode[]): string {
  return JSON.stringify({ type: 'doc', content });
}
/** 前 n 个 Unicode 码点（不按 UTF-16 单元切）。 */
export function firstCodePoints(value: string, n: number): string {
  return [...value].slice(0, n).join('');
}
export function codePointLength(value: string): number {
  return [...value].length;
}
