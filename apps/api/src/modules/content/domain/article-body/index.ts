export interface ArticleBodyOptions {
  readonly mediaHosts: readonly string[];
}

export type ArticleBodyResult = { ok: true } | { ok: false; fields: ['body']; path: string };

/** Shared article / agreement JSON whitelist (F1-02m §9.2). */
export function validateArticleBody(body: string, opts: ArticleBodyOptions): ArticleBodyResult {
  void body;
  void opts;
  throw new Error('NotImplemented: validateArticleBody');
}

/** SHA-256 of the stored string's UTF-8 bytes, without parsing or canonicalisation. */
export function textSha256(body: string): string {
  void body;
  throw new Error('NotImplemented: textSha256');
}
