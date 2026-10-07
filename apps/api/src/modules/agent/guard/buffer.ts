// BR-AI-06 细则「按句缓冲」: sentence buffer shared with output-side review (BR-AI-18).
// Segments come out as raw text (unfiltered); the guard filters them. Neither a sentence end nor
// a forced cut falls inside a link, passcode or amount: an ASCII ? or ! inside a link is not a
// sentence end, and a forced cut steps back before any hit or open token it would split.
import { riskSpans } from './filter.ts';

export interface SentenceBuffer {
  push(delta: string): string[];
  end(): string[];
}

const SENTENCE_ENDS = new Set(['。', '！', '？', '；', '!', '?', '\n', '\r']);
const FORCE_AT = 60;
// BR-AI-06「复制…打开(淘宝|京东|拼多多)」: once 复制 is in the open sentence and its 打开X has not
// arrived, the forced flush at FORCE_AT waits, so a passcode between them is not delivered before
// the whole match can be deleted. The wait is bounded (memory): from COPY_HOLD_LIMIT code points
// on, the usual forced-flush rule applies again.
const COPY_HOLD_LIMIT = 2000;
const COPY_OPEN_ENDS = ['打开淘宝', '打开京东', '打开拼多多'];
const DIGIT = /^\p{Nd}$/u;
const SPACE = /^\s$/u;
// A forced cut keeps a tail that may still grow into a hit (O-G4 and cross-segment links,
// passcodes and 打开…): an ASCII-like token, then amount characters (with 块 / 元, so the 角
// digit after them is never split off) and amount trigger words.
const TOKEN_CHAR = /^[\x21-\x7e！-～\p{Sc}]$/u;
const AMOUNT_CHAR =
  /^[\s\p{Nd}.．%％\p{Sc}零〇一二两兩三四五六七八九十百千万萬亿億壹贰貳叁叄參肆伍陆陸柒捌玖拾佰仟块塊元圓圆]$/u;
const TRIGGERS = ['立减', '到手', '返', '省', '减', '券', '满'];
const PARTIAL_AT_END = ['打开拼多', '打开淘', '打开京', '打开拼', '打开', '打', '复', '立', '到'];

function previousCodePointStart(text: string, end: number): number {
  const low = text.charCodeAt(end - 1);
  if (end >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(end - 2);
    if (high >= 0xd800 && high <= 0xdbff) return end - 2;
  }
  return end - 1;
}

function stripWhile(text: string, end: number, test: RegExp): number {
  let i = end;
  while (i > 0) {
    const start = previousCodePointStart(text, i);
    if (!test.test(text.slice(start, i))) break;
    i = start;
  }
  return i;
}

function nextCodePointEnd(text: string, start: number): number {
  const high = text.charCodeAt(start);
  if (high >= 0xd800 && high <= 0xdbff) {
    const low = text.charCodeAt(start + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return start + 2;
  }
  return start + 1;
}

function isTokenAt(text: string, start: number): boolean {
  if (start < 0 || start >= text.length) return false;
  return TOKEN_CHAR.test(text.slice(start, nextCodePointEnd(text, start)));
}

/**
 * UTF-16 offset where the retained tail of a forced cut starts: the BR-AI-06 run of digits,
 * points, white space and currency signs, widened (O-G4) until it neither splits an ASCII-like
 * token, an amount trigger word, nor a hit span; an amount hit at the cut is kept whole, so a
 * neighbouring amount in the next text still merges into one placeholder.
 */
function retainFrom(text: string): number {
  let i = text.length;
  for (const partial of PARTIAL_AT_END) {
    if (text.endsWith(partial)) {
      i -= partial.length;
      break;
    }
  }
  i = stripWhile(text, i, TOKEN_CHAR);
  let spans: readonly { start: number; end: number; kind: string }[] | null = null;
  for (;;) {
    const before = i;
    i = stripWhile(text, i, AMOUNT_CHAR);
    const trigger = TRIGGERS.find((word) => text.startsWith(word, i - word.length));
    if (trigger !== undefined) i -= trigger.length;
    if (i > 0 && isTokenAt(text, previousCodePointStart(text, i)) && isTokenAt(text, i)) {
      i = stripWhile(text, i, TOKEN_CHAR);
    }
    if (i > 0) {
      spans ??= riskSpans(text);
      for (const span of spans) {
        if (span.start < i && (i < span.end || (i === span.end && span.kind === 'amount'))) {
          i = span.start;
        }
      }
    }
    if (i === before || i === 0) return i;
  }
}

// An ASCII ? or ! continues a link when the URL-character run before it already reads as one
// (scheme, www. or a listed suffix); fullwidth forms count by their NFKC character.
const URL_CHAR = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]$/u;
const LINK_LIKE = /:\/\/|www\.|\.(?:com|cn|net|top|cc|vip)(?![a-z0-9-])/u;
const PROSE_FULLWIDTH = '，；！？（）';

function asciiForm(ch: string): string {
  const code = ch.charCodeAt(0);
  if (ch.length === 1 && code >= 0xff01 && code <= 0xff5e && !PROSE_FULLWIDTH.includes(ch)) {
    return String.fromCharCode(code - 0xfee0);
  }
  return ch;
}

function insideLink(text: string): boolean {
  let i = text.length;
  let run = '';
  while (i > 0) {
    const ascii = asciiForm(text.charAt(i - 1));
    if (!URL_CHAR.test(ascii)) break;
    run = ascii + run;
    i -= 1;
  }
  return run !== '' && LINK_LIKE.test(run.toLowerCase());
}

function countCodePoints(text: string): number {
  let n = 0;
  for (const ch of text) {
    void ch;
    n += 1;
  }
  return n;
}

export function createSentenceBuffer(): SentenceBuffer {
  let buffer = '';
  let size = 0;
  let pendingHigh = '';
  let pendingDot = false;
  let previous = '';
  // The whole buffer is one ASCII-like token, or only amount characters: retainFrom is then
  // exactly 0 (nothing can be cut), so a long unbroken run is not rescanned per code point.
  let allToken = true;
  let allAmount = true;
  // 复制 is in the buffer and no 打开X has followed it yet.
  let copyOpen = false;

  const flush = (out: string[]): void => {
    if (buffer !== '') out.push(buffer);
    buffer = '';
    size = 0;
    allToken = true;
    allAmount = true;
    copyOpen = false;
  };

  const rescan = (): void => {
    allToken = true;
    allAmount = true;
    for (const ch of buffer) {
      if (allToken && !TOKEN_CHAR.test(ch)) allToken = false;
      if (allAmount && !AMOUNT_CHAR.test(ch)) allAmount = false;
      if (!allToken && !allAmount) break;
    }
  };

  const feed = (ch: string, out: string[]): void => {
    if (pendingDot) {
      pendingDot = false;
      if (SPACE.test(ch)) flush(out);
    }
    const linkMark = (ch === '?' || ch === '!') && insideLink(buffer);
    buffer += ch;
    size += 1;
    if (allToken && !TOKEN_CHAR.test(ch)) allToken = false;
    if (allAmount && !AMOUNT_CHAR.test(ch)) allAmount = false;
    if (SENTENCE_ENDS.has(ch) && !linkMark) {
      flush(out);
    } else if (ch === '.' && !DIGIT.test(previous)) {
      pendingDot = true;
    }
    previous = ch;
    if (buffer.endsWith('复制')) copyOpen = true;
    else if (copyOpen && COPY_OPEN_ENDS.some((end) => buffer.endsWith(end))) copyOpen = false;
    const holding = copyOpen && size < COPY_HOLD_LIMIT;
    if (size >= FORCE_AT && !allToken && !allAmount && !holding) {
      const keep = retainFrom(buffer);
      if (keep > 0) {
        out.push(buffer.slice(0, keep));
        buffer = buffer.slice(keep);
        size = countCodePoints(buffer);
        rescan();
      }
    }
  };

  return {
    push(delta) {
      const out: string[] = [];
      let text = pendingHigh + delta;
      pendingHigh = '';
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        pendingHigh = text.slice(-1);
        text = text.slice(0, -1);
      }
      for (const ch of text) feed(ch, out);
      return out;
    },
    end() {
      const out: string[] = [];
      if (pendingHigh !== '') feed(pendingHigh, out);
      pendingHigh = '';
      pendingDot = false;
      flush(out);
      previous = '';
      return out;
    },
  };
}

/**
 * Sentence count of delivered text, by the BR-AI-06 sentence ends: 。！？；!? and line breaks;
 * an ASCII `.` only before white space or the end of text and not after a digit. Pieces that
 * are only white space do not count. Appending text never lowers the count.
 */
export interface SentenceCount {
  readonly count: number;
  readonly open: boolean;
  readonly dot: boolean;
  readonly dotAfterDigit: boolean;
  readonly previous: string;
}

export const EMPTY_COUNT: SentenceCount = {
  count: 0,
  open: false,
  dot: false,
  dotAfterDigit: false,
  previous: '',
};

export function countStep(state: SentenceCount, ch: string): SentenceCount {
  let { count, open } = state;
  const space = SPACE.test(ch);
  if (state.dot) {
    if (space && !state.dotAfterDigit) {
      if (open) count += 1;
      open = false;
    } else {
      open = true;
    }
  }
  if (SENTENCE_ENDS.has(ch)) {
    if (open) count += 1;
    return { count, open: false, dot: false, dotAfterDigit: false, previous: ch };
  }
  if (ch === '.') {
    return { count, open, dot: true, dotAfterDigit: DIGIT.test(state.previous), previous: ch };
  }
  return { count, open: open || !space, dot: false, dotAfterDigit: false, previous: ch };
}

export function finalCount(state: SentenceCount): number {
  if (state.dot && state.dotAfterDigit) return state.count + 1;
  return state.count + (state.open ? 1 : 0);
}

export function hasOpenSentence(state: SentenceCount): boolean {
  return state.open || state.dot;
}
