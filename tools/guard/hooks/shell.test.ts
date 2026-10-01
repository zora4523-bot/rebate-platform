import { describe, expect, it } from 'vitest';
import { effectiveCommand, programName, splitCommands } from './shell.ts';

function words(command: string): string[][] {
  return splitCommands(command).map((c) => c.words.map((w) => w.text));
}

describe('splitCommands', () => {
  it('splits on every command separator', () => {
    expect(words('a 1; b 2 && c 3 || d 4 | e 5 & f 6\ng 7')).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
      ['d', '4'],
      ['e', '5'],
      ['f', '6'],
      ['g', '7'],
    ]);
  });

  it('removes quotes and escapes and keeps quoted separators inside the word', () => {
    expect(words(`echo "a; b" 'c && d' e\\ f "g\\"h" co\\dex $'tab\\there'`)).toEqual([
      ['echo', 'a; b', 'c && d', 'e f', 'g"h', 'codex', 'tab\there'],
    ]);
  });

  it('joins lines continued with a backslash and drops comments', () => {
    expect(words('codex \\\n  exec hi # trailing comment\n# full line\nls')).toEqual([
      ['codex', 'exec', 'hi'],
      ['ls'],
    ]);
  });

  it('collects command and process substitutions, also inside double quotes', () => {
    const [cmd] = splitCommands('echo "$(cat a.txt)" `whoami` <(sort b.txt) $((1 + 2))');
    expect(cmd?.subs).toEqual(['cat a.txt', 'whoami', 'sort b.txt']);
    expect(cmd?.words.map((w) => w.dynamic)).toEqual([false, true, true, true, true]);
  });

  it('handles nested substitutions and parentheses in quotes', () => {
    const [cmd] = splitCommands('x=$(echo "$(inner ")")" tail)');
    expect(cmd?.subs).toEqual(['echo "$(inner ")")" tail']);
  });

  it('marks variables as dynamic and keeps their text', () => {
    const [cmd] = splitCommands('rm -rf "$HOME/x" ${TMPDIR}/y plain');
    expect(cmd?.words).toEqual([
      { text: 'rm', dynamic: false },
      { text: '-rf', dynamic: false },
      { text: '$HOME/x', dynamic: true },
      { text: '${TMPDIR}/y', dynamic: true },
      { text: 'plain', dynamic: false },
    ]);
  });

  it('separates redirection targets from arguments', () => {
    const [cmd] = splitCommands('codex exec x < /dev/null > out.jsonl 2> err.txt 2>&1 &> all.txt');
    expect(cmd?.words.map((w) => w.text)).toEqual(['codex', 'exec', 'x']);
    expect(cmd?.redirects.map((w) => w.text)).toEqual([
      '/dev/null',
      'out.jsonl',
      'err.txt',
      'all.txt',
    ]);
  });

  it('reads here-documents and here-strings as inputs', () => {
    const cmds = splitCommands("bash <<'EOF'\ncodex exec hi\necho done\nEOF\ncat <<< 'text' ; ls");
    expect(cmds.map((c) => c.words.map((w) => w.text))).toEqual([['bash'], ['cat'], ['ls']]);
    expect(cmds[0]?.inputs).toEqual(['codex exec hi\necho done']);
    expect(cmds[1]?.inputs).toEqual(['text']);
  });

  it('treats subshell parentheses as separators', () => {
    expect(words('(cd /tmp && ls) ; { echo a; }')).toEqual([
      ['cd', '/tmp'],
      ['ls'],
      ['{', 'echo', 'a'],
      ['}'],
    ]);
  });

  it('survives unterminated quotes and substitutions', () => {
    expect(words(`echo "unterminated`)).toEqual([['echo', 'unterminated']]);
    expect(splitCommands('echo $(never closed')[0]?.subs).toEqual(['never closed']);
  });
});

describe('programName', () => {
  it('strips directories, scopes and versions', () => {
    expect(programName('/opt/homebrew/bin/codex')).toBe('codex');
    expect(programName('./node_modules/.bin/codex')).toBe('codex');
    expect(programName('@openai/codex@latest')).toBe('codex');
    expect(programName('codex@0.154.0')).toBe('codex');
    expect(programName('tools/agent/codex-run.sh')).toBe('codex-run.sh');
  });
});

describe('effectiveCommand', () => {
  function effective(command: string): { env: Record<string, string>; argv: string[] } {
    const eff = effectiveCommand(splitCommands(command)[0]?.words ?? []);
    return { env: eff.env, argv: eff.argv.map((w) => w.text) };
  }

  it('collects the env prefix', () => {
    expect(effective('A=1 B="two words" codex exec')).toEqual({
      env: { A: '1', B: 'two words' },
      argv: ['codex', 'exec'],
    });
  });

  it.each([
    ['command codex exec', ['codex', 'exec']],
    ['env -i A=1 codex exec', ['codex', 'exec']],
    ['env -u HOME codex exec', ['codex', 'exec']],
    ['exec -a name codex exec', ['codex', 'exec']],
    ['nohup codex exec', ['codex', 'exec']],
    ['time -p codex exec', ['codex', 'exec']],
    ['sudo -u nobody codex exec', ['codex', 'exec']],
    ['caffeinate -i -t 60 codex exec', ['codex', 'exec']],
    ['timeout -s KILL 30 codex exec', ['codex', 'exec']],
    ['nice -n 5 nohup command codex exec', ['codex', 'exec']],
    ['xargs -I {} -n 1 codex exec', ['codex', 'exec']],
    ['npx -y @openai/codex exec', ['@openai/codex', 'exec']],
    ['pnpm dlx @openai/codex exec', ['@openai/codex', 'exec']],
    ['pnpm exec codex exec', ['codex', 'exec']],
    ['if codex exec', ['codex', 'exec']],
    ['pnpm install', ['pnpm', 'install']],
    ['command -v codex', []],
  ])('unwraps %s', (command, argv) => {
    expect(effective(command).argv).toEqual(argv);
  });

  it('keeps env assignments given through the env wrapper', () => {
    expect(effective('env COULI_CODEX_WRAPPER=1 codex exec').env).toEqual({
      COULI_CODEX_WRAPPER: '1',
    });
  });

  it('recognises a bare env, xargs and env -S', () => {
    const cmd = (c: string) => effectiveCommand(splitCommands(c)[0]?.words ?? []);
    expect(cmd('env').bareEnv).toBe(true);
    expect(cmd('env A=1 node x.js').bareEnv).toBe(false);
    expect(cmd('xargs rm -f').viaXargs).toBe(true);
    expect(cmd('env -S "codex exec hi"').nested).toEqual(['codex exec hi']);
  });
});
