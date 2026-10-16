// B3-05d: candidate selection (BR-AI-01 parse_input row) and the free text the keyword and
// parameter checks read. Candidate spans come from parsing's findCandidateSpans, the same source
// B3-05a's redactForModel uses, so both see the same links and passwords.
import { findCandidateSpans } from '../../../parsing/index.ts';
import type { Candidate } from '../../../parsing/index.ts';

/** Every link and password in text order, duplicates included. */
export function findCandidates(text: string): readonly Candidate[] {
  return findCandidateSpans(text);
}

/** First occurrence of each distinct candidate, then the first `limit`; `dropped` counts the rest. */
export function selectCandidates(
  all: readonly Candidate[],
  limit: number,
): { readonly kept: Candidate[]; readonly dropped: number } {
  const seen = new Set<string>();
  const distinct: Candidate[] = [];
  for (const candidate of all) {
    const key = `${candidate.kind}\u0000${candidate.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push({ kind: candidate.kind, raw: candidate.raw, index: candidate.index });
  }
  return { kept: distinct.slice(0, limit), dropped: Math.max(0, distinct.length - limit) };
}

/** The original text with each candidate replaced by one space (unredacted). */
export function withoutCandidates(text: string, candidates: readonly Candidate[]): string {
  let out = '';
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.index < cursor) continue;
    out += `${text.slice(cursor, candidate.index)} `;
    cursor = candidate.index + candidate.raw.length;
  }
  return out + text.slice(cursor);
}
