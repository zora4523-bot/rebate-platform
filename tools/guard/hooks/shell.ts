// A small shell-command reader for the PreToolUse hook. It does not execute or expand anything:
// it splits a command line into simple commands and words so that rules can look at program
// names, flags and paths instead of matching raw text. It errs on the side of splitting too much.

export type Word = {
  /** The word with quotes removed. Variables and substitutions are kept as written or dropped. */
  text: string;
  /** True when the word contains a variable, command substitution or other expansion. */
  dynamic: boolean;
};

export type SimpleCommand = {
  words: Word[];
  /** Targets of file redirections (`> file`, `< file`). */
  redirects: Word[];
  /** Here-document bodies and here-strings fed to the command. */
  inputs: string[];
  /** Bodies of command and process substitutions that appear in the command. */
  subs: string[];
};

function newCommand(): SimpleCommand {
  return { words: [], redirects: [], inputs: [], subs: [] };
}

function isEmpty(cmd: SimpleCommand): boolean {
  return (
    cmd.words.length === 0 &&
    cmd.redirects.length === 0 &&
    cmd.inputs.length === 0 &&
    cmd.subs.length === 0
  );
}

const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'" };

/** Splits a shell command line into simple commands (separated by `;`, `&&`, `|`, newlines, ...). */
export function splitCommands(src: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  const pendingHeredocs: { cmd: SimpleCommand; delimiter: string; stripTabs: boolean }[] = [];
  let cur = newCommand();
  let text = '';
  let has = false;
  let dynamic = false;
  let pending: 'target' | 'heredoc' | 'herestring' | null = null;
  let stripTabs = false;

  const endWord = (): void => {
    if (!has) return;
    if (pending === 'target') cur.redirects.push({ text, dynamic });
    else if (pending === 'heredoc') pendingHeredocs.push({ cmd: cur, delimiter: text, stripTabs });
    else if (pending === 'herestring') cur.inputs.push(text);
    else cur.words.push({ text, dynamic });
    pending = null;
    text = '';
    has = false;
    dynamic = false;
  };

  const endCommand = (): void => {
    endWord();
    pending = null;
    if (!isEmpty(cur) || pendingHeredocs.some((h) => h.cmd === cur)) commands.push(cur);
    cur = newCommand();
  };

  /** Index of the `)` matching the `(` at `open`, or src.length when it is not closed. */
  const matchParen = (open: number): number => {
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      const d = src[j];
      if (d === '\\') {
        j++;
      } else if (d === "'") {
        const end = src.indexOf("'", j + 1);
        if (end === -1) return src.length;
        j = end;
      } else if (d === '"') {
        j = skipDoubleQuoted(j);
      } else if (d === '(') {
        depth++;
      } else if (d === ')') {
        depth--;
        if (depth === 0) return j;
      }
    }
    return src.length;
  };

  /** Index of the `"` closing the double-quoted string that starts at `start`. */
  const skipDoubleQuoted = (start: number): number => {
    let j = start + 1;
    while (j < src.length && src[j] !== '"') {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '$' && src[j + 1] === '(') j = matchParen(j + 1) + 1;
      else j++;
    }
    return j;
  };

  const findBacktick = (from: number): number => {
    for (let j = from; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '`') return j;
    }
    return src.length;
  };

  /** Handles `$...` at index i (outside single quotes); returns the index of its last character. */
  const readDollar = (i: number): number => {
    const next = src[i + 1];
    if (next === '(') {
      if (src[i + 2] === '(') {
        const end = src.indexOf('))', i + 3);
        dynamic = true;
        has = true;
        return end === -1 ? src.length : end + 1;
      }
      const end = matchParen(i + 1);
      cur.subs.push(src.slice(i + 2, end));
      dynamic = true;
      has = true;
      return end;
    }
    if (next === '{') {
      const end = src.indexOf('}', i + 2);
      const stop = end === -1 ? src.length - 1 : end;
      text += src.slice(i, stop + 1);
      dynamic = true;
      has = true;
      return stop;
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] ?? '')) j++;
      text += src.slice(i, j);
      dynamic = true;
      has = true;
      return j - 1;
    }
    if (next !== undefined && /[0-9@*#?!$-]/.test(next)) {
      text += src.slice(i, i + 2);
      dynamic = true;
      has = true;
      return i + 1;
    }
    text += '$';
    has = true;
    return i;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? '';
    const next = src[i + 1];

    if (c === '\\') {
      if (next === '\n') {
        i++;
      } else if (next !== undefined) {
        text += next;
        has = true;
        i++;
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      text += src.slice(i + 1, stop);
      has = true;
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        const d = src[j] ?? '';
        if (d === '\\' && j + 1 < src.length) {
          const e = src[j + 1] ?? '';
          if (e !== '\n') text += '$`"\\'.includes(e) ? e : `\\${e}`;
          j += 2;
        } else if (d === '`') {
          const end = findBacktick(j + 1);
          cur.subs.push(src.slice(j + 1, end));
          dynamic = true;
          j = end + 1;
        } else if (d === '$') {
          j = readDollar(j) + 1;
        } else {
          text += d;
          j++;
        }
      }
      has = true;
      i = j;
    } else if (c === '`') {
      const end = findBacktick(i + 1);
      cur.subs.push(src.slice(i + 1, end));
      dynamic = true;
      has = true;
      i = end;
    } else if (c === '$' && next === "'") {
      let j = i + 2;
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] ?? '';
          text += ANSI_ESCAPES[e] ?? e;
          j += 2;
        } else {
          text += src[j];
          j++;
        }
      }
      has = true;
      i = j;
    } else if (c === '$') {
      i = readDollar(i);
    } else if ((c === '<' || c === '>') && next === '(') {
      const end = matchParen(i + 1);
      cur.subs.push(src.slice(i + 2, end));
      dynamic = true;
      has = true;
      i = end;
    } else if (c === '<' || c === '>') {
      // A number directly in front of the operator is a file descriptor, not an argument.
      if (has && /^\d+$/.test(text)) {
        text = '';
        has = false;
      } else {
        endWord();
      }
      let j = i + 1;
      let kind: 'target' | 'heredoc' | 'herestring' | 'dup' = 'target';
      let strip = false;
      if (c === '>') {
        if (src[j] === '>' || src[j] === '|') j++;
        if (src[j] === '&') {
          j++;
          kind = 'dup';
        }
      } else if (src[j] === '<') {
        j++;
        if (src[j] === '<') {
          j++;
          kind = 'herestring';
        } else {
          if (src[j] === '-') {
            j++;
            strip = true;
          }
          kind = 'heredoc';
        }
      } else if (src[j] === '&') {
        j++;
        kind = 'dup';
      } else if (src[j] === '>') {
        j++;
      }
      i = j - 1;
      if (kind === 'dup') {
        let k = j;
        while (src[k] === ' ') k++;
        const fd = /^(\d+|-)(?=$|[\s;&|()<>])/.exec(src.slice(k));
        if (fd) i = k + fd[0].length - 1;
        else pending = 'target';
      } else {
        pending = kind;
        stripTabs = strip;
      }
    } else if (c === '&') {
      if (next === '>') {
        endWord();
      } else {
        if (next === '&') i++;
        endCommand();
      }
    } else if (c === '|') {
      if (next === '|' || next === '&') i++;
      endCommand();
    } else if (c === ';' || c === '(' || c === ')') {
      endCommand();
    } else if (c === '\n') {
      endCommand();
      if (pendingHeredocs.length > 0) {
        let pos = i + 1;
        for (const doc of pendingHeredocs) {
          const lines: string[] = [];
          while (pos <= src.length) {
            const nl = src.indexOf('\n', pos);
            const line = src.slice(pos, nl === -1 ? src.length : nl);
            pos = nl === -1 ? src.length + 1 : nl + 1;
            if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
            lines.push(line);
          }
          doc.cmd.inputs.push(lines.join('\n'));
        }
        pendingHeredocs.length = 0;
        i = pos - 1;
      }
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
    } else if (c === '#' && !has) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl - 1;
    } else {
      text += c;
      has = true;
    }
  }
  endCommand();
  return commands;
}

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', '}']);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/s;

// Wrapper programs that run another command given in their arguments, with the options of
// each wrapper that consume the following argument.
const WRAPPERS: Record<string, readonly string[]> = {
  command: [],
  builtin: [],
  exec: ['-a'],
  nohup: [],
  time: [],
  setsid: [],
  caffeinate: ['-t', '-w'],
  nice: ['-n'],
  ionice: ['-c', '-n', '-p'],
  sudo: ['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D'],
  doas: ['-u', '-C'],
  stdbuf: ['-i', '-o', '-e'],
  arch: ['-arch'],
  env: ['-u', '-C', '-P'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  gtimeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '-R', '-J'],
  npx: ['-p', '--package', '-c', '--call'],
  pnpx: ['-p', '--package'],
  bunx: ['-p', '--package'],
};

// `pnpm dlx <pkg>`, `pnpm exec <bin>`, `yarn dlx <pkg>`, `npm exec <bin>`, `bun x <pkg>`.
const RUNNER_SUBCOMMANDS: Record<string, readonly string[]> = {
  pnpm: ['dlx', 'exec'],
  yarn: ['dlx', 'exec'],
  npm: ['exec', 'x'],
  bun: ['x'],
};

/** Program name of a command word: basename, without a package scope or version suffix. */
export function programName(word: string): string {
  let name = word.replace(/\/+$/, '');
  const slash = name.lastIndexOf('/');
  if (slash !== -1) name = name.slice(slash + 1);
  const at = name.indexOf('@', 1);
  if (at !== -1) name = name.slice(0, at);
  return name;
}

export type Effective = {
  /** Environment assignments that apply to the program (`A=1 cmd`, `env A=1 cmd`). */
  env: Record<string, string>;
  /** The program and its arguments after wrappers such as `command`, `env`, `sudo`, `xargs`. */
  argv: Word[];
  /** True when the arguments come from `xargs` (and are therefore unknown). */
  viaXargs: boolean;
  /** True when `env` is used without a command (it prints the environment). */
  bareEnv: boolean;
  /** Command lines passed as a single string (`env -S "<command line>"`). */
  nested: string[];
};

/** Strips reserved words, leading assignments and wrapper programs from a simple command. */
export function effectiveCommand(words: readonly Word[]): Effective {
  const env = Object.create(null) as Record<string, string>;
  let argv = [...words];
  let viaXargs = false;
  let bareEnv = false;
  const nested: string[] = [];

  const takeAssignments = (): void => {
    for (;;) {
      const first = argv[0];
      const m = first ? ASSIGNMENT.exec(first.text) : null;
      if (!m) return;
      env[m[1] ?? ''] = m[2] ?? '';
      argv = argv.slice(1);
    }
  };

  while (argv[0] && RESERVED.has(argv[0].text)) argv = argv.slice(1);
  takeAssignments();

  for (let guard = 0; guard < 16 && argv[0]; guard++) {
    const name = programName(argv[0].text);
    const runner = Object.hasOwn(RUNNER_SUBCOMMANDS, name) ? RUNNER_SUBCOMMANDS[name] : undefined;
    if (runner) {
      // Skip the runner's own flags, then its subcommand; anything else is not a wrapper use.
      let i = 1;
      while (argv[i]?.text.startsWith('-')) i++;
      if (!runner.includes(argv[i]?.text ?? '')) break;
      i++;
      while (argv[i]?.text.startsWith('-')) i++;
      argv = argv.slice(i);
      continue;
    }
    const valueFlags = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (!valueFlags) break;
    let i = 1;
    let lookupOnly = false;
    while (argv[i]) {
      const arg = argv[i]?.text ?? '';
      if (name === 'env' && (arg === '-S' || arg === '--split-string')) {
        // `env -S "<command line>"`: the next word is itself a command line.
        nested.push(argv[i + 1]?.text ?? '');
        i += 2;
        continue;
      }
      // `command -v name` only looks the name up; nothing is executed.
      if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(arg)) lookupOnly = true;
      if (arg === '--') {
        i++;
        break;
      }
      if (!arg.startsWith('-') || arg === '-') {
        if (arg === '-' && name === 'env') {
          i++;
          continue;
        }
        break;
      }
      i += valueFlags.includes(arg) ? 2 : 1;
    }
    if (name === 'timeout' || name === 'gtimeout') i++;
    if (name === 'xargs') viaXargs = true;
    argv = lookupOnly ? [] : argv.slice(i);
    takeAssignments();
    if (name === 'env' && argv.length === 0) bareEnv = true;
  }
  return { env, argv, viaXargs, bareEnv, nested };
}
