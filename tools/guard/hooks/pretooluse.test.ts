import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../../lib/paths.ts';
import { codexExecProblems, decide, parseProdHosts, sensitivePath } from './pretooluse.ts';
import type { HookContext } from './pretooluse.ts';

const CTX: Partial<HookContext> = {
  home: '/Users/owner',
  workspaceRoots: ['/work/repo'],
  tmpRoots: ['/tmp', '/private/tmp'],
  prodHosts: ['api.couli.example'],
  currentBranch: (dir) => (dir.startsWith('/work/main-checkout') ? 'main' : 'task/B2-03a'),
};

function bash(command: string, cwd = '/work/repo'): ReturnType<typeof decide> {
  return decide({ tool_name: 'Bash', tool_input: { command }, cwd }, CTX);
}

const WRAPPED =
  'COULI_CODEX_WRAPPER=1 codex exec -C /runs/worktrees/B2-03a -s workspace-write ' +
  '--ignore-user-config --ignore-rules --json -m gpt-6-astra -c \'model_reasoning_effort="high"\' ' +
  "-c 'skills.include_instructions=false' --disable plugins " +
  "-c 'sandbox_workspace_write.exclude_slash_tmp=true' " +
  '--output-schema /trusted/tools/agent/schemas/impl.schema.json -o /runs/B2-03a/impl.json ' +
  '"$(cat /runs/B2-03a/brief.md)" < /dev/null > /runs/B2-03a/events.jsonl 2> /runs/B2-03a/err.txt';

const SAFE_FLAGS = '-s read-only --ignore-rules --ignore-user-config';

type Case = [name: string, command: string, decision: 'allow' | 'ask' | 'deny'];

describe('codex exec: deny unless it is exactly what the wrapper runs', () => {
  const cases: Case[] = [
    ['bare codex exec', 'codex exec hello', 'deny'],
    // Flaw 1 of the earlier sample: it let danger-full-access through.
    [
      'flaw 1: danger-full-access as the sandbox',
      'COULI_CODEX_WRAPPER=1 codex exec -s danger-full-access --ignore-rules --ignore-user-config x',
      'deny',
    ],
    [
      'flaw 1: danger-full-access through -c',
      `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} -c 'sandbox="danger-full-access"' x`,
      'deny',
    ],
    // Flaw 2: it matched only the literal text "codex exec".
    ['flaw 2: extra whitespace', 'codex    exec   hello', 'deny'],
    ['flaw 2: absolute path', '/opt/homebrew/bin/codex exec hello', 'deny'],
    ['flaw 2: unrelated env prefix', 'FOO=1 BAR=2 codex exec hello', 'deny'],
    ['flaw 2: command wrapper', 'command codex exec hello', 'deny'],
    ['flaw 2: env wrapper', 'env -i PATH=/usr/bin codex exec hello', 'deny'],
    ['flaw 2: chained with &&', 'cd /somewhere && codex exec hello', 'deny'],
    ['flaw 2: chained with ;', 'true; codex exec hello', 'deny'],
    ['flaw 2: chained with a newline', 'echo start\ncodex exec hello', 'deny'],
    ['flaw 2: behind a pipe', 'cat brief.md | codex exec -', 'deny'],
    ['flaw 2: bash -c', 'bash -c "codex exec hello"', 'deny'],
    ['flaw 2: sh -lc', "sh -lc 'cd /x && codex exec hello'", 'deny'],
    ['flaw 2: eval', 'eval "codex exec hello"', 'deny'],
    ['flaw 2: command substitution', 'OUT=$(codex exec hello)', 'deny'],
    ['flaw 2: backticks', 'echo `codex exec hello`', 'deny'],
    ['flaw 2: here-document fed to a shell', "bash <<'EOF'\ncodex exec hello\nEOF", 'deny'],
    ['flaw 2: quoted program name', '"codex" exec hello', 'deny'],
    ['flaw 2: escaped program name', 'co\\dex exec hello', 'deny'],
    ['flaw 2: line continuation', 'codex \\\n  exec hello', 'deny'],
    ['flaw 2: exec alias', 'codex e hello', 'deny'],
    ['flaw 2: global option before exec', 'codex -m gpt-6-astra exec hello', 'deny'],
    ['flaw 2: nohup in the background', 'nohup codex exec hello &', 'deny'],
    ['flaw 2: caffeinate', 'caffeinate -i codex exec hello', 'deny'],
    ['flaw 2: timeout', 'timeout 1800 codex exec hello', 'deny'],
    ['flaw 2: xargs', 'cat prompts.txt | xargs codex exec', 'deny'],
    ['flaw 2: npx', 'npx -y @openai/codex exec hello', 'deny'],
    ['flaw 2: perl timeout wrapper', "perl -e 'alarm 5; exec @ARGV' codex exec hello", 'deny'],
    ['flaw 2: the shim file run through bash', 'bash tools/guard/shim/codex exec hello', 'deny'],
    ['flaw 2: env -S', 'env -S "codex exec hello"', 'deny'],
    // Flaw 3: it did not look at --ignore-rules or network_access.
    [
      'flaw 3: missing --ignore-rules',
      'COULI_CODEX_WRAPPER=1 codex exec -s workspace-write --ignore-user-config x',
      'deny',
    ],
    [
      'flaw 3: missing --ignore-user-config',
      'COULI_CODEX_WRAPPER=1 codex exec -s workspace-write --ignore-rules x',
      'deny',
    ],
    [
      'flaw 3: network_access=true',
      `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} -c sandbox_workspace_write.network_access=true x`,
      'deny',
    ],
    [
      'flaw 3: no sandbox flag at all',
      'COULI_CODEX_WRAPPER=1 codex exec --ignore-rules --ignore-user-config x',
      'deny',
    ],
    ['--add-dir', `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} --add-dir /work x`, 'deny'],
    ['--worktree', `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} --worktree x`, 'deny'],
    [
      'sandbox_mode passed through',
      `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} -c 'sandbox_mode="read-only"' x`,
      'deny',
    ],
    [
      'sandbox value from a variable',
      'COULI_CODEX_WRAPPER=1 codex exec -s "$MODE" --ignore-rules --ignore-user-config x',
      'deny',
    ],
    // Tightening beyond the list in 规划/11 §8, checked against `codex exec --help` (0.154.0).
    ['bypass alias --yolo', `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} --yolo x`, 'deny'],
    [
      'another --dangerously- flag',
      `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} --dangerously-bypass-hook-trust x`,
      'deny',
    ],
    ['a profile with -p', `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} -p loose x`, 'deny'],
    [
      'a profile with --profile=',
      `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} --profile=loose x`,
      'deny',
    ],
    [
      '--approve-for-me',
      `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} --approve-for-me x`,
      'deny',
    ],
    [
      'writable roots through -c',
      `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} -c 'sandbox_workspace_write.writable_roots=["/"]' x`,
      'deny',
    ],
    [
      'network access through an inline table with a quoted key',
      `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} -c 'sandbox_workspace_write={"network_access"=true}' x`,
      'deny',
    ],
    [
      'legacy sandbox_permissions through --config',
      `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} --config 'sandbox_permissions=["disk-full-write-access"]' x`,
      'deny',
    ],
    ['flaw 2: value option before exec', 'codex --remote ws://127.0.0.1:9 exec hello', 'deny'],
    ['flaw 2: unknown option before exec', 'codex --brand-new-option value exec hello', 'deny'],
    // Flaw 4: the marker must be in the command's own env prefix.
    [
      'flaw 4: marker exported earlier in the chain',
      `export COULI_CODEX_WRAPPER=1; codex exec ${SAFE_FLAGS} x`,
      'deny',
    ],
    [
      'flaw 4: marker with another value',
      `COULI_CODEX_WRAPPER=0 codex exec ${SAFE_FLAGS} x`,
      'deny',
    ],
    [
      'flaw 4: marker on a different command',
      `COULI_CODEX_WRAPPER=1 true && codex exec ${SAFE_FLAGS} x`,
      'deny',
    ],
    // The dangerous flag is refused wherever it appears.
    [
      'bypass flag on a compliant command',
      `COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} --dangerously-bypass-approvals-and-sandbox x`,
      'deny',
    ],
    ['bypass flag in any command', 'echo --dangerously-bypass-approvals-and-sandbox', 'deny'],
    // What is allowed.
    ['the wrapper script', 'tools/agent/codex-run.sh impl B2-03a', 'allow'],
    [
      'the wrapper script through bash',
      'bash tools/agent/codex-run.sh review B2-03a --review-type money',
      'allow',
    ],
    // A compliant hand-typed command is still not the wrapper (no position assertion, no
    // group kill, no ledger, no output validation): the owner decides.
    ['the exact implementation command of 规划/11 §2.4', WRAPPED, 'ask'],
    [
      'a read-only review command',
      `COULI_CODEX_WRAPPER=1 codex exec -C /wt --sandbox=read-only --ignore-user-config --ignore-rules --json x < /dev/null`,
      'ask',
    ],
    [
      'marker through the env wrapper',
      `env COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} x`,
      'ask',
    ],
    // Ways to start codex that the parser cannot see through.
    ['command text piped into sh', "echo 'codex exec hi' | sh", 'ask'],
    ['command text piped into bash -s', "printf 'codex exec hi' | bash -s", 'ask'],
    [
      'python subprocess',
      `python3 -c 'import subprocess; subprocess.run(["codex","exec","hi"])'`,
      'ask',
    ],
    ['node spawn', `node -e 'require("child_process").spawnSync("codex",["exec","hi"])'`, 'ask'],
    ['alias', 'alias cx=codex; cx exec hi', 'ask'],
    ['trap', "trap 'codex exec hi' EXIT", 'ask'],
    ['a shell script file without codex in the text', 'sh run-all.sh', 'allow'],
    ['codex --version', 'codex --version', 'allow'],
    ['looking codex up', 'command -v codex && which codex', 'allow'],
    ['reading the shim', 'cat tools/guard/shim/codex', 'allow'],
    ['searching for the words', 'grep -rn "codex exec" tools/', 'allow'],
    ['a commit message that mentions it', 'git commit -m "wrap codex exec in a script"', 'allow'],
    // Other ways to start codex need the owner.
    ['interactive codex', 'codex', 'ask'],
    ['codex with a prompt', 'codex "fix the bug"', 'ask'],
    ['another codex subcommand', 'codex login', 'ask'],
    ['program from a variable followed by exec', '$CODEX_BIN exec hello', 'ask'],
  ];

  it.each(cases)('%s', (_name, command, decision) => {
    expect(bash(command).decision).toBe(decision);
  });

  it('flaw 4: ignores COULI_CODEX_WRAPPER in the environment of the hook itself', () => {
    const saved = process.env['COULI_CODEX_WRAPPER'];
    process.env['COULI_CODEX_WRAPPER'] = '1';
    try {
      expect(bash(`codex exec ${SAFE_FLAGS} x`).decision).toBe('deny');
    } finally {
      if (saved === undefined) delete process.env['COULI_CODEX_WRAPPER'];
      else process.env['COULI_CODEX_WRAPPER'] = saved;
    }
  });

  it('can be limited to the project directories, asking elsewhere', () => {
    const scoped = { ...CTX, codexDenyRoots: ['/work/repo', '/work/couli-runs'] };
    const run = (command: string, cwd: string, workspace = cwd): string =>
      decide(
        { tool_name: 'Bash', tool_input: { command }, cwd },
        { ...scoped, workspaceRoots: [workspace] },
      ).decision;
    expect(run('codex exec hello', '/work/repo/apps/api')).toBe('deny');
    expect(run('codex exec hello', '/work/couli-runs/worktrees/B2-03a')).toBe('deny');
    expect(run('codex exec hello', '/elsewhere/project')).toBe('ask');
    expect(run('codex exec -C /work/repo hello', '/elsewhere/project')).toBe('deny');
    expect(run('codex exec --cd=../../work/repo hello', '/elsewhere/project')).toBe('deny');
    expect(run('codex exec -C "$DIR" hello', '/elsewhere/project')).toBe('deny');
    expect(run('cd /work/repo && codex exec hello', '/elsewhere/project')).toBe('deny');
    expect(run('cd "$SOMEWHERE" && codex exec hello', '/elsewhere/project')).toBe('deny');
    expect(run('cd /tmp && codex exec hello', '/tmp', '/work/repo')).toBe('deny');
    expect(run('codex exec --dangerously-bypass-approvals-and-sandbox x', '/elsewhere')).toBe(
      'deny',
    );
    // A compliant command line is a question everywhere (it is still not the wrapper).
    expect(run(`COULI_CODEX_WRAPPER=1 codex exec ${SAFE_FLAGS} x`, '/elsewhere/project')).toBe(
      'ask',
    );
  });

  it('names every unmet condition', () => {
    expect(codexExecProblems(['exec', 'hello'], {})).toEqual([
      '命令自身的环境前缀里没有 COULI_CODEX_WRAPPER=1',
      '没有显式沙箱参数 -s / --sandbox',
      '缺少 --ignore-rules',
      '缺少 --ignore-user-config',
    ]);
    expect(bash('codex exec hello').reason).toContain('tools/agent/codex-run.sh');
  });

  it('accepts only the one sandbox key the wrapper sets through -c', () => {
    const env = { COULI_CODEX_WRAPPER: '1' };
    const base = ['exec', '-s', 'workspace-write', '--ignore-rules', '--ignore-user-config'];
    expect(
      codexExecProblems(
        [
          ...base,
          '-c',
          'sandbox_workspace_write.exclude_slash_tmp=true',
          '-c',
          'model_reasoning_effort="high"',
          '--disable',
          'plugins',
          'x',
        ],
        env,
      ),
    ).toEqual([]);
    expect(
      codexExecProblems(
        [...base, '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'x'],
        env,
      ),
    ).toEqual([
      '用 -c 改了沙箱配置 sandbox_workspace_write.exclude_tmpdir_env_var（只允许 sandbox_workspace_write.exclude_slash_tmp）',
    ]);
    expect(codexExecProblems([...base, '--config=sandbox_permissions=[]', 'x'], env)).toEqual([
      '用 -c 改了沙箱配置 sandbox_permissions（只允许 sandbox_workspace_write.exclude_slash_tmp）',
    ]);
    expect(codexExecProblems([...base, '--yolo', '-p', 'loose', 'x'], env)).toEqual([
      '使用了跳过沙箱或确认的参数 --yolo',
      '使用了 --profile（会叠加另一份配置）',
    ]);
  });
});

describe('ask-class commands (规划/11 §8)', () => {
  const cases: Case[] = [
    // .env and key material
    ['cat .env', 'cat .env', 'ask'],
    ['cat .env.local', 'cat config/.env.local', 'ask'],
    ['sourcing .env', 'set -a; . ./.env; set +a', 'ask'],
    ['.env as stdin', 'grep KEY < .env', 'ask'],
    ['.env through an option value', 'docker compose --env-file=.env up -d', 'ask'],
    ['.env.example', 'cat .env.example && cp .env.example /tmp/x', 'allow'],
    ['writing .gitignore lines', 'echo ".env" >> .gitignore', 'allow'],
    ['p12 certificate', 'openssl pkcs12 -in certs/dist.p12 -nokeys', 'ask'],
    ['pem key', 'cat keys/alipay_private.pem', 'ask'],
    ['jks keystore', 'keytool -list -keystore release.jks', 'ask'],
    ['provisioning profile', 'security cms -D -i app.mobileprovision', 'ask'],
    ['ssh key', 'cat ~/.ssh/id_ed25519', 'ask'],
    ['ssh directory', 'ls -la /Users/owner/.ssh', 'ask'],
    // environment dumps
    ['printenv', 'printenv', 'ask'],
    ['printenv of one variable', 'printenv GH_TOKEN', 'ask'],
    ['bare env', 'env | sort', 'ask'],
    ['export -p', 'export -p', 'ask'],
    ['env as a wrapper', 'env NODE_ENV=test node script.js', 'allow'],
    // gh
    ['gh repo create', 'gh repo create zora/rebate-platform --public', 'ask'],
    ['gh repo delete', 'gh repo delete zora/rebate-platform --yes', 'ask'],
    ['gh repo edit', 'gh repo edit --visibility private', 'ask'],
    ['gh repo view', 'gh repo view --json name', 'allow'],
    ['gh secret', 'gh secret set ALIYUN_KEY', 'ask'],
    ['gh api -X DELETE', 'gh api -X DELETE repos/o/r/rulesets/1', 'ask'],
    ['gh api -XPUT', 'gh api -XPUT repos/o/r/branches/main/protection', 'ask'],
    ['gh api --method PATCH', 'gh api --method PATCH repos/o/r -f allow_auto_merge=true', 'ask'],
    ['gh api --method=put', 'gh api --method=put repos/o/r/topics', 'ask'],
    ['gh api GET', 'gh api repos/o/r/pulls --paginate', 'allow'],
    // Writing through gh api: explicit POST, or a body that makes it POST (statuses, labels).
    ['gh api POST status', 'gh api -X POST repos/o/r/statuses/abc -f state=success', 'ask'],
    [
      'gh api implicit POST',
      'gh api repos/o/r/statuses/abc -f state=success -f context=longrun-props',
      'ask',
    ],
    ['gh api POST with --input', 'gh api -X POST repos/o/r/rulesets --input x.json', 'ask'],
    ['gh api --raw-field', 'gh api repos/o/r/issues/1/labels --raw-field labels=x', 'ask'],
    ['gh pr merge --admin', 'gh pr merge 12 --squash --admin', 'ask'],
    ['gh pr merge --auto', 'gh pr merge --auto --squash 5', 'ask'],
    ['gh pr merge', 'gh pr merge 12 --squash --match-head-commit abc123', 'allow'],
    [
      'gh pr edit owner-approved label',
      'gh pr edit 5 --add-label owner-approved-abcdef012345',
      'ask',
    ],
    ['gh pr edit label from a variable', 'gh pr edit 5 --add-label "$LABEL"', 'ask'],
    ['gh pr edit other label', 'gh pr edit 5 --add-label needs-rebase', 'allow'],
    [
      'gh issue edit owner-approved label',
      'gh issue edit 5 --add-label=owner-approved-abcdef012345',
      'ask',
    ],
    ['gh run rerun', 'gh run rerun 123', 'ask'],
    ['gh run view', 'gh run view 123 --log', 'allow'],
    ['gh release create', 'gh release create v1.0.0', 'ask'],
    ['gh release list', 'gh release list', 'allow'],
    ['gh workflow run', 'gh workflow run ci.yml', 'ask'],
    ['gh workflow run with -R', 'gh -R o/r workflow run ci.yml', 'ask'],
    ['gh pr create', 'gh pr create --fill', 'allow'],
    // git push
    ['git push --force', 'git push --force', 'ask'],
    ['git push -f', 'git push -f origin task/B2-03a', 'ask'],
    ['git push --force-with-lease', 'git push --force-with-lease origin task/B2-03a', 'ask'],
    ['git push +refspec', 'git push origin +task/B2-03a', 'ask'],
    ['git push origin main', 'git push origin main', 'ask'],
    ['git push -u origin main', 'git push -u origin main', 'ask'],
    ['git push HEAD:main', 'git push origin HEAD:main', 'ask'],
    ['git push HEAD:refs/heads/main', 'git push origin HEAD:refs/heads/main', 'ask'],
    ['git push --all', 'git push --all origin', 'ask'],
    ['git push --delete', 'git push origin --delete task/B2-03a', 'ask'],
    ['git push of a task branch', 'git push -u origin task/B2-03a', 'allow'],
    ['git push on a task branch', 'git push', 'allow'],
    ['git push -C main checkout', 'git -C /work/main-checkout push', 'ask'],
    ['git push --dry-run of a task branch', 'git push --dry-run origin task/B2-03a', 'allow'],
    ['other git commands', 'git status && git log --oneline -5 && git fetch origin main', 'allow'],
    // Dynamic or wildcard targets may name main.
    [
      'git push of the current branch by substitution',
      'git push origin "$(git branch --show-current)"',
      'ask',
    ],
    ['git push of a variable', 'B=main; git push origin $B', 'ask'],
    ['git push wildcard refspec', "git push origin 'refs/heads/*:refs/heads/*'", 'ask'],
    ['git push --prune', "git push --prune origin 'refs/heads/*:refs/heads/*'", 'ask'],
    // Bypassing the pre-commit secret scan.
    ['git commit --no-verify', 'git commit --no-verify -m x', 'ask'],
    ['git commit -n', 'git commit -n -m x', 'ask'],
    ['git commit -am', 'git commit -am x', 'allow'],
    ['git -c core.hooksPath', 'git -c core.hooksPath=/dev/null commit -m x', 'ask'],
    ['git config core.hooksPath', 'git config core.hooksPath /dev/null', 'ask'],
    ['git config of something else', 'git config user.name test', 'allow'],
    ['git merge --no-verify', 'git merge --no-verify task/x', 'ask'],
    // Key material (same list as .gitignore).
    ['.key file', 'cat certs/prod.key', 'ask'],
    ['.pfx file', 'cat x.pfx', 'ask'],
    ['.keystore file', 'cat release.keystore', 'ask'],
    // deletion outside the workspace
    ['rm inside the workspace', 'rm -rf dist build/.cache', 'allow'],
    ['rm by absolute workspace path', 'rm -f /work/repo/.tmp/x.log', 'allow'],
    ['rm in the temp directory', 'rm -rf /tmp/couli-scratch "$TMPDIR/y"', 'allow'],
    ['rm after cd inside', 'cd packages/money && rm -rf dist', 'allow'],
    ['rm in the home directory', 'rm -rf ~/Documents/old', 'ask'],
    ['rm through $HOME', 'rm -rf "$HOME/.cache/x"', 'ask'],
    ['rm above the workspace', 'rm -rf ../couli', 'ask'],
    ['rm of the file system root', 'rm -rf /*', 'ask'],
    ['rm of an unknown variable', 'rm -rf "$TARGET"', 'ask'],
    ['rm after cd outside', 'cd /etc && rm hosts', 'ask'],
    ['rmdir outside', 'rmdir /Users/owner/empty', 'ask'],
    ['find -delete inside', "find . -name '*.log' -delete", 'allow'],
    ['find -delete outside', "find / -name '*.log' -delete", 'ask'],
    ['find -exec rm outside', 'find /var/log -type f -exec rm {} \;', 'ask'],
    ['xargs rm', 'git ls-files -o | xargs rm -f', 'ask'],
    // production hosts
    ['curl to a production host', 'curl -s https://API.couli.example/health', 'ask'],
    ['curl elsewhere', 'curl -s https://registry.npmjs.org/vitest', 'allow'],
    // everyday commands
    ['verify', 'pnpm verify:fast && node tools/guard/run.ts static', 'allow'],
    ['empty command', '', 'allow'],
  ];

  it.each(cases)('%s', (_name, command, decision) => {
    expect(bash(command).decision).toBe(decision);
  });

  it('asks on a bare git push from the main checkout', () => {
    expect(bash('git push', '/work/main-checkout').decision).toBe('ask');
    expect(bash('git push origin HEAD', '/work/main-checkout').decision).toBe('ask');
  });

  it('gives the reason in Chinese', () => {
    expect(bash('gh repo delete x --yes').reason).toBe('gh repo delete：建库、删库或改仓库设置');
    expect(bash('rm -rf ~/x').reason).toBe('在工作区之外删除：/Users/owner/x');
  });

  it('lets deny win over ask and keeps the deny reason', () => {
    const res = bash('cat .env && codex exec hello');
    expect(res.decision).toBe('deny');
    expect(res.reason).toContain('codex exec');
  });

  it('asks when commands nest too deeply to follow', () => {
    let command = 'ls';
    for (let i = 0; i < 9; i++) command = `bash -c ${JSON.stringify(command)}`;
    expect(bash(command).decision).toBe('ask');
  });
});

describe('other tools', () => {
  const cases: [name: string, tool: string, input: Record<string, unknown>, decision: string][] = [
    ['Read .env', 'Read', { file_path: '/work/repo/.env' }, 'ask'],
    ['Read .env.example', 'Read', { file_path: '/work/repo/.env.example' }, 'allow'],
    ['Read an ssh key', 'Read', { file_path: '/Users/owner/.ssh/id_rsa' }, 'ask'],
    [
      'Edit a pem file',
      'Edit',
      { file_path: 'config/prod.pem', old_string: 'a', new_string: 'b' },
      'ask',
    ],
    ['Write .env.production', 'Write', { file_path: '.env.production', content: 'X=1' }, 'ask'],
    ['Grep in .env.local', 'Grep', { pattern: 'KEY', path: '.env.local' }, 'ask'],
    ['Write source code', 'Write', { file_path: 'src/environment.ts', content: '' }, 'allow'],
    [
      'WebFetch of a production host',
      'WebFetch',
      { url: 'https://api.couli.example/admin' },
      'ask',
    ],
    ['WebFetch elsewhere', 'WebFetch', { url: 'https://nodejs.org' }, 'allow'],
    ['an unknown tool', 'TodoWrite', { todos: [] }, 'allow'],
    ['Bash without a command', 'Bash', {}, 'allow'],
  ];

  it.each(cases)('%s', (_name, tool, input, decision) => {
    expect(decide({ tool_name: tool, tool_input: input, cwd: '/work/repo' }, CTX).decision).toBe(
      decision,
    );
  });

  it('is not confused by program names that are also object properties', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(bash(`${name} exec hello`).decision).toBe('allow');
      expect(bash(`__proto__=1 ${name}=2 codex exec hello`).decision).toBe('deny');
    }
  });

  it('tolerates malformed input', () => {
    expect(decide({}).decision).toBe('allow');
    expect(decide({ tool_name: 'Bash', tool_input: 'not an object' }).decision).toBe('allow');
    expect(decide({ tool_name: 42, tool_input: null }).decision).toBe('allow');
  });
});

describe('helpers', () => {
  it('classifies sensitive paths', () => {
    expect(sensitivePath('.env')).not.toBeNull();
    expect(sensitivePath('apps/api/.env.staging')).not.toBeNull();
    expect(sensitivePath('HEAD:.env')).not.toBeNull();
    expect(sensitivePath('.env.example')).toBeNull();
    expect(sensitivePath('src/env.ts')).toBeNull();
    expect(sensitivePath('docs/dotenv.md')).toBeNull();
    expect(sensitivePath('certs/a.P12')).not.toBeNull();
    expect(sensitivePath('add .env handling to the docs')).toBeNull();
  });

  it('parses the production host list', () => {
    expect(
      parseProdHosts('# comment\n\napi.couli.example # prod API\n admin.couli.example\n'),
    ).toEqual(['api.couli.example', 'admin.couli.example']);
  });

  it('ships an empty production host list for now', () => {
    const text = execFileSync('cat', [join(repoRoot(), 'tools/guard/hooks/prod-hosts.txt')], {
      encoding: 'utf8',
    });
    expect(parseProdHosts(text)).toEqual([]);
    expect(text).toContain('TODO(规划/11 §8)');
  });
});

describe('command line', () => {
  const script = join(repoRoot(), 'tools', 'guard', 'hooks', 'pretooluse.ts');
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  function run(input: unknown, env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [script], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: '/work/repo', ...env },
    });
  }

  it('denies with exit code 2, the reason on stderr and the decision on stdout', () => {
    const res = run({
      tool_name: 'Bash',
      tool_input: { command: 'codex exec hello' },
      cwd: '/work/repo',
    });
    expect(res.status).toBe(2);
    expect(String(res.stderr)).toContain('已拒绝');
    const out = JSON.parse(String(res.stdout)) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string };
    };
    expect(out.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
  });

  it('still denies when the hook process itself carries the wrapper marker', () => {
    const res = run(
      { tool_name: 'Bash', tool_input: { command: 'codex exec hello' }, cwd: '/work/repo' },
      { COULI_CODEX_WRAPPER: '1' },
    );
    expect(res.status).toBe(2);
  });

  it('asks with exit code 0 and a permission decision', () => {
    const res = run({
      tool_name: 'Bash',
      tool_input: { command: 'gh secret list' },
      cwd: '/work/repo',
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(String(res.stdout)) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('gh secret');
  });

  it('turns ask into deny when COULI_HOOK_ASK_AS_DENY=1', () => {
    const res = run(
      { tool_name: 'Bash', tool_input: { command: 'gh secret list' }, cwd: '/work/repo' },
      { COULI_HOOK_ASK_AS_DENY: '1' },
    );
    expect(res.status).toBe(2);
  });

  it('prints nothing and exits 0 when it has no objection', () => {
    const res = run({ tool_name: 'Bash', tool_input: { command: 'pnpm test' }, cwd: '/work/repo' });
    expect(res.status).toBe(0);
    expect(String(res.stdout)).toBe('');
  });

  it('does not block the session on input it cannot parse', () => {
    const res = run('not json');
    expect(res.status).toBe(0);
    expect(String(res.stderr)).toContain('nothing was checked');
  });
});
