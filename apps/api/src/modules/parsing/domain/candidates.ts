// B1-07a: candidate extraction for parse_input (规划/04 §8.5). Extraction is loose on purpose: the
// union interface is the judge. Everything outside the URLs and passwords is untrusted text
// (BR-AI-05) and is never read for identity, prices or instructions.

/** Up to three links or passwords per message, in text order (BR-AI-01 parse_input row). */
export const MAX_CANDIDATES = 3;

export interface Candidate {
  readonly kind: 'url' | 'tpwd';
  readonly raw: string;
  readonly index: number;
}

// A URL runs over printable ASCII (0x21-0x7E) minus quotes, backtick and angle brackets, so CJK
// punctuation, any other non-ASCII character and whitespace end it. A nested "https://" inside a
// query string stays part of the outer URL (the scan consumes it).
const URL_RE = /https?:\/\/[!#-&(-;=?-_a-~]+/gi;
// Share-text password: a currency-like delimiter, 6–32 letters/digits with at least one letter.
const TPWD_DELIMITERS = '￥¥$€£₤₳¢₴₰₵₲₭₮₱₹₣₦₩';
const TPWD_RE = new RegExp(
  `[${TPWD_DELIMITERS}](?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{6,32}[${TPWD_DELIMITERS}]`,
  'g',
);
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** Candidates in text order, at most MAX_CANDIDATES; a failed or duplicate one still counts. */
export function extractCandidates(text: string): readonly Candidate[] {
  const urls: Candidate[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, '');
    if (raw.length > 0) urls.push({ kind: 'url', raw, index: match.index });
  }
  const insideUrl = (index: number, length: number) =>
    urls.some((url) => index < url.index + url.raw.length && index + length > url.index);
  const passwords: Candidate[] = [];
  for (const match of text.matchAll(TPWD_RE)) {
    if (!insideUrl(match.index, match[0].length)) {
      passwords.push({ kind: 'tpwd', raw: match[0], index: match.index });
    }
  }
  return [...urls, ...passwords].sort((a, b) => a.index - b.index).slice(0, MAX_CANDIDATES);
}
