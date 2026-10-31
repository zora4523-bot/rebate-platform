/**
 * 01 §4.2 Help / 04 §6.2 summary (CT-26a, W-25): the list summary of an article version, derived
 * from its stored body — the plain text of the first non-empty text paragraph of the tiptap
 * document (images, dividers, empty and whitespace-only paragraphs skipped; marks and links give
 * their text only), cut to its first 80 Unicode code points. Undefined when the body has no text
 * paragraph or is not a tiptap JSON document; never throws.
 */
export function articleListSummary(body: string): string | undefined {
  void body;
  throw new Error('NotImplemented: articleListSummary');
}
