// Hidden Unicode scan (规划/11 §4.1; 规划/02 §12.7): bidirectional controls and zero-width or
// otherwise invisible characters can make source text read differently from what it does.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const NAMES: Record<number, string> = {
  0x00ad: 'SOFT HYPHEN',
  0x061c: 'ARABIC LETTER MARK',
  0x115f: 'HANGUL CHOSEONG FILLER',
  0x1160: 'HANGUL JUNGSEONG FILLER',
  0x180e: 'MONGOLIAN VOWEL SEPARATOR',
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LEFT-TO-RIGHT MARK',
  0x200f: 'RIGHT-TO-LEFT MARK',
  0x2028: 'LINE SEPARATOR',
  0x2029: 'PARAGRAPH SEPARATOR',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING',
  0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING',
  0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2060: 'WORD JOINER',
  0x2061: 'FUNCTION APPLICATION',
  0x2062: 'INVISIBLE TIMES',
  0x2063: 'INVISIBLE SEPARATOR',
  0x2064: 'INVISIBLE PLUS',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
  0x3164: 'HANGUL FILLER',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE (BOM)',
  0xffa0: 'HALFWIDTH HANGUL FILLER',
};

function isHidden(codePoint: number): boolean {
  return codePoint in NAMES || (codePoint >= 0xe0000 && codePoint <= 0xe007f);
}

export type HiddenChar = { line: number; column: number; codePoint: number; name: string };

/** Hidden characters in a text, with 1-based line and column (in code points). */
export function findHiddenUnicode(text: string): HiddenChar[] {
  const found: HiddenChar[] = [];
  let line = 1;
  let column = 0;
  for (const ch of text) {
    if (ch === '\n') {
      line++;
      column = 0;
      continue;
    }
    column++;
    const codePoint = ch.codePointAt(0) ?? 0;
    if (isHidden(codePoint)) {
      found.push({ line, column, codePoint, name: NAMES[codePoint] ?? 'TAG CHARACTER' });
    }
  }
  return found;
}

const MAX_BYTES = 20 * 1024 * 1024;

/** Scans the given repo-relative files; binary files (a NUL byte early on) are skipped. */
export function scanFilesForHiddenUnicode(
  root: string,
  files: readonly string[],
): { problems: string[]; notices: string[]; scanned: number } {
  const problems: string[] = [];
  const notices: string[] = [];
  let scanned = 0;
  for (const file of files) {
    const full = join(root, file);
    if (statSync(full).size > MAX_BYTES) {
      notices.push(`${file}: larger than ${MAX_BYTES} bytes, not scanned`);
      continue;
    }
    const buffer = readFileSync(full);
    if (buffer.subarray(0, 8000).includes(0)) continue;
    scanned++;
    for (const hit of findHiddenUnicode(buffer.toString('utf8'))) {
      const hex = hit.codePoint.toString(16).toUpperCase().padStart(4, '0');
      problems.push(`${file}:${hit.line}:${hit.column}: U+${hex} ${hit.name}`);
    }
  }
  return { problems, notices, scanned };
}
