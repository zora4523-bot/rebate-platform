// Banned terms (规划/11 §5.5): technology names superseded by ADR-0001 must not appear in the
// planning tree at SPEC_REF or in a task brief.
import { matchesAny } from '../../lib/glob.ts';

export type Term = { text: string; wholeWord: boolean; re: RegExp };
export type AllowEntry = { glob: string; re: RegExp };
export type TermHit = { file: string; line: number; term: string; excerpt: string };

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

/** One term per line; `#` starts a comment line; `word:` asks for a whole-word match. */
export function parseTerms(text: string): Term[] {
  const terms: Term[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const wholeWord = line.startsWith('word:');
    const term = (wholeWord ? line.slice('word:'.length) : line).trim();
    if (term === '') throw new Error(`banned-terms.txt: empty term in line "${raw}"`);
    const body = term.split(/\s+/).map(escapeRegExp).join('\\s+');
    const source = wholeWord ? `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])` : body;
    terms.push({ text: term, wholeWord, re: new RegExp(source, 'i') });
  }
  return terms;
}

/** Lines of `<path glob><TAB><regular expression>`; `#` starts a comment line. */
export function parseAllow(text: string): AllowEntry[] {
  const entries: AllowEntry[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === '' || raw.startsWith('#')) return;
    const tab = raw.indexOf('\t');
    if (tab <= 0 || tab === raw.length - 1) {
      throw new Error(`banned-terms.allow.txt: line ${index + 1} must be "<glob><TAB><regex>"`);
    }
    const source = raw.slice(tab + 1);
    let re: RegExp;
    try {
      re = new RegExp(source, 'u');
    } catch (err) {
      throw new Error(
        `banned-terms.allow.txt: line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    entries.push({ glob: raw.slice(0, tab), re });
  });
  return entries;
}

/** Hits in one text; a hit is dropped when an allow entry matches both the path and the line. */
export function scanText(
  file: string,
  content: string,
  terms: readonly Term[],
  allow: readonly AllowEntry[],
): TermHit[] {
  const hits: TermHit[] = [];
  const applicable = allow.filter((entry) => matchesAny(file, [entry.glob]));
  content.split(/\r?\n/).forEach((lineText, index) => {
    const matched = terms.filter((term) => term.re.test(lineText));
    if (matched.length === 0) return;
    if (applicable.some((entry) => entry.re.test(lineText))) return;
    for (const term of matched) {
      const at = term.re.exec(lineText)?.index ?? 0;
      const start = Math.max(0, at - 30);
      hits.push({
        file,
        line: index + 1,
        term: term.text,
        excerpt: lineText.slice(start, at + term.text.length + 30).trim(),
      });
    }
  });
  return hits;
}
