// B3-08i: cutting one published article into rule chunks (02 §9.2 规则 RAG; 08 BR-AI-07 T6
// rule_ref excerpt ≤ 200 字; no vectors, D10-194). Pure. The body is the stored tiptap JSON
// (F1-02m); every textblock (paragraph, heading, also inside lists and quotes) is one paragraph and
// a chunk never spans two paragraphs. A paragraph over 200 characters (Unicode code points, as
// char_length in agent_rule_chunks_text_check) is cut again at 。 or a line break (hardBreak), and
// a piece still over 200 is cut hard. Chunk title is the article title; seq counts from 0.

/** What a chunk is cut from: the article's title and stored body. */
export interface RuleChunkSource {
  readonly title: string;
  readonly body: string;
}

export interface RuleChunkDraft {
  readonly seq: number;
  readonly title: string;
  readonly text: string;
}

export function chunkArticle(article: RuleChunkSource): readonly RuleChunkDraft[] {
  void article;
  throw new Error('NotImplemented: chunkArticle');
}
