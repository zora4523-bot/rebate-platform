// Minimal glob matcher for repo-relative POSIX paths (task `paths`, risk map, protected paths).
// Supported: `**` (whole path segments, zero or more), `*` and `?` (never cross `/`), `{a,b}`.
// Wildcards also match dotfiles: gates must see `.claude/settings.json` under `.claude/**`.
// Matching is case-sensitive; callers that need case-insensitive matching lower-case both sides.

const REGEX_SYNTAX = new Set([
  '\\',
  '^',
  '$',
  '.',
  '*',
  '+',
  '?',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '/',
]);

function escapeChar(c: string): string {
  return REGEX_SYNTAX.has(c) ? `\\${c}` : c;
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchingBrace(glob: string, open: number): number {
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\') {
      i++;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits on commas that are not inside nested braces. */
export function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (c === '\\') {
      current += c + (text[i + 1] ?? '');
      i++;
    } else if (c === '{') {
      depth++;
      current += c;
    } else if (c === '}') {
      depth--;
      current += c;
    } else if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts;
}

function convert(glob: string, atSegmentStart: boolean): string {
  let out = '';
  let segStart = atSegmentStart;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '\\') {
      const next = glob[i + 1];
      if (next === undefined) throw new Error(`glob ends with a dangling backslash: ${glob}`);
      out += escapeChar(next);
      i++;
      segStart = false;
    } else if (c === '*') {
      let j = i;
      while (glob[j + 1] === '*') j++;
      const stars = j - i + 1;
      const next = glob[j + 1];
      if (stars >= 2 && segStart && (next === '/' || next === undefined)) {
        if (next === '/') {
          out += '(?:[^/]+/)*';
          i = j + 1;
          segStart = true;
        } else {
          out += '[\\s\\S]*';
          i = j;
          segStart = false;
        }
      } else {
        out += '[^/]*';
        i = j;
        segStart = false;
      }
    } else if (c === '?') {
      out += '[^/]';
      segStart = false;
    } else if (c === '{') {
      const close = matchingBrace(glob, i);
      if (close === -1) throw new Error(`unbalanced "{" in glob: ${glob}`);
      const alternatives = splitTopLevelCommas(glob.slice(i + 1, close));
      out += `(?:${alternatives.map((alt) => convert(alt, segStart)).join('|')})`;
      i = close;
      segStart = false;
    } else if (c === '}') {
      throw new Error(`unbalanced "}" in glob: ${glob}`);
    } else {
      out += escapeChar(c);
      segStart = c === '/';
    }
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  if (glob === '') throw new Error('empty glob');
  return new RegExp(`^${convert(glob.normalize('NFC'), true)}$`, 'u');
}

const cache = new Map<string, RegExp>();

export function matchesAny(path: string, globs: readonly string[]): boolean {
  const p = path.normalize('NFC');
  for (const glob of globs) {
    let re = cache.get(glob);
    if (!re) {
      re = globToRegExp(glob);
      cache.set(glob, re);
    }
    if (re.test(p)) return true;
  }
  return false;
}

/** True when the glob contains a wildcard or brace group (i.e. it is not a literal path). */
export function hasWildcard(glob: string): boolean {
  return /[*?{]/.test(glob.replace(/\\./g, ''));
}
