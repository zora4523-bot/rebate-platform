import { expect, it } from 'vitest';
import {
  asset,
  imageVariable,
  noInlineCredentials,
  record,
  services,
  sourceLines,
  string,
} from './kit.ts';

// Static audit contract: keep the deployment sequence at script top level, with a direct
// docker run migration followed by `if [!] docker compose … up … --wait; then … else … fi`.
// Single-line/nested ifs and logging functions are supported. Deployment commands remain
// top-level: sourced helpers, loops, eval and heredocs cannot be audited by text order.
// This tests a small, reviewable shell workflow, never executes it.
interface HealthGate {
  prefix: string[];
  condition: string;
  success: string[];
  failure: string[];
  suffix: string[];
}

// Split shell statements only outside quotes/parameter expansion/command substitution.
// In particular `if …; then …; fi` and `log() { printf '…'; }` have the same shape
// as multiline forms. Quoted probe text and 2>&1 are left untouched.
function statements(text: string): string[] {
  const result: string[] = [];
  for (const line of sourceLines(text)) {
    let start = 0;
    let quote = '';
    let substitution = 0;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '\\' && quote !== "'") {
        i++;
        continue;
      }
      if (quote) {
        if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '$' && /[({]/.test(line[i + 1] ?? '')) {
        substitution++;
        i++;
        continue;
      }
      if (substitution && /[)}]/.test(char ?? '')) {
        substitution--;
        continue;
      }
      if (
        !substitution &&
        (char === ';' || ((char === '{' || char === '}') && /\s|^$/.test(line[i - 1] ?? '')))
      ) {
        result.push(line.slice(start, i).trim());
        if (char !== ';') result.push(char ?? '');
        start = i + 1;
      }
    }
    result.push(line.slice(start).trim());
  }
  return result.filter(Boolean).flatMap((line) => {
    const keyword = /^(then|else)\s+(.+)$/.exec(line);
    return keyword ? [keyword[1] ?? '', keyword[2] ?? ''] : [line];
  });
}

function script(): string[] {
  const text = asset('infra/staging/deploy.sh');
  expect(text).toMatch(/^#!\s*\/(?:usr\/bin\/env\s+bash|bin\/bash)\r?\n/);
  const all = statements(text);
  expect(all[0]).toMatch(/^set\s+-[Eeuo]+\s+pipefail$/);
  for (const option of ['e', 'u', 'o']) expect(all[0]?.split(/\s+/)[1]).toContain(option);
  const lines: string[] = [];
  for (let i = 0; i < all.length; i++) {
    if (/^(?:function\s+)?[\w-]+\s*\(\)$/.test(all[i] ?? '')) {
      expect(all[++i]).toBe('{');
      // Accept helper definitions without mistaking their body for executed commands.
      // Logging is harmless; control flow, assignments and docker in helpers are not.
      while (++i < all.length && all[i] !== '}') {
        expect(all[i]).toMatch(/^(?:echo|printf)\s/);
        expect(all[i]?.replace(/(?:\d*)>&[12]/g, '')).not.toMatch(/\$\(|[|&>]/);
      }
      expect(all[i]).toBe('}');
    } else lines.push(all[i] ?? '');
  }
  const code = lines.join('\n');
  expect(code).not.toMatch(/^(?:(?:for|while|until|case|eval|source)\s|\.\s)/m);
  expect(code).not.toMatch(/<<|`/);
  expect(code).not.toMatch(/^set\s+.*(?:\+e|\+o\s+errexit|-\w*x|\bxtrace\b)/m);
  return lines;
}

function healthGate(): HealthGate {
  const lines = script();
  const matches = lines.flatMap((line, index) =>
    /^if\s+(?:!\s+)?docker\s+compose\s+.*\bup\b.*--wait(?:\s|;|$)/.test(line) ? [index] : [],
  );
  expect(matches, 'one conditional switch, whose status includes health checks').toHaveLength(1);
  const start = matches[0] ?? -1;
  const condition = lines[start] ?? '';
  expect(condition).toMatch(/--wait-timeout(?:=|\s+)[1-9]\d*/);
  expect(condition).not.toMatch(/\|\||&&|;/);
  expect(lines[start + 1]).toBe('then');
  const branches: [string[], string[]] = [[], []];
  let branch: 0 | 1 = 0;
  let depth = 1;
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^if\s/.test(line)) depth++;
    if (/^fi(?:;|$)/.test(line)) depth--;
    if (depth === 0) {
      end = i;
      break;
    }
    if (depth === 1 && line === 'else') {
      branch = 1;
      continue;
    }
    expect(line).not.toMatch(/^elif\s/);
    branches[branch].push(line);
  }
  expect(end, 'the health conditional must close').toBeGreaterThan(start);
  const negated = /^if\s+!\s/.test(condition);
  return {
    prefix: lines.slice(0, start),
    condition,
    success: branches[negated ? 1 : 0],
    failure: branches[negated ? 0 : 1],
    suffix: lines.slice(end + 1),
  };
}

function unquote(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, '$2');
}

function assignments(lines: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of lines) {
    const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.+)$/.exec(line);
    if (match) values.set(match[1] ?? '', unquote(match[2] ?? ''));
  }
  return values;
}

function expand(value: string, values: Map<string, string>, seen: string[] = []): string {
  return value.replace(
    /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g,
    (token: string, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? '';
      expect(seen, 'shell variable assignments must not be cyclic').not.toContain(name);
      const replacement = values.get(name);
      return replacement === undefined ? token : expand(replacement, values, [...seen, name]);
    },
  );
}

function topLevel(lines: string[]): string[] {
  let depth = 0;
  return lines.filter((line) => {
    if (/^if\s/.test(line)) depth++;
    if (line === 'fi') {
      depth--;
      return false;
    }
    return depth === 0 && line !== 'then';
  });
}

it('[AC-B1-01zc-DEPLOY#1] 接受新镜像参数，迁移成功之后才切换并等待健康', () => {
  const gate = healthGate();
  const variable = imageVariable();
  const prefix = gate.prefix.join('\n');
  // Bind the very variable used by compose, not an unrelated tag mentioned in a message.
  const assignment = new RegExp(`^(?:export\\s+)?${variable}=`, 'm');
  const values = assignments(gate.prefix);
  expect(expand(values.get(variable) ?? '', values)).toMatch(/\$1\b|\$\{1(?::[^}]*)?\}/);
  expect(prefix, 'compose interpolation needs an exported image variable').toMatch(
    new RegExp(`^export\\s+${variable}(?:=|\\s*$)`, 'm'),
  );
  const migrations = gate.prefix.filter(
    (line) => /^docker\s+run\s/.test(line) && /\b(?:db:migrate|migrate\.(?:ts|js))\b/.test(line),
  );
  expect(migrations, 'one real foreground migration invocation').toHaveLength(1);
  const migration = migrations[0] ?? '';
  expect(migration).toMatch(
    /--env-file(?:=|\s+)["']?\/etc\/couli\/staging-migrator\.env["']?(?:\s|$)/,
  );
  expect(migration).toMatch(new RegExp(`\\$\\{?${variable}\\}?`));
  expect(migration).toMatch(/--rm\b/);
  expect(migration).toMatch(/\b(?:pnpm\b[^\n]*\bdb:migrate|node\b[^\n]*\bmigrate\.(?:ts|js))\b/);
  expect(migration).not.toMatch(/\b(?:echo|true|sleep)\b/);
  expect(migration.replace(/\d*>&\d+/g, '')).not.toMatch(
    /\|\||&&|[;&]|(?:^|\s)(?:-d|--detach)(?:\s|$)/,
  );
  expect(migration).not.toContain('/etc/couli/staging.env');
  expect(migration).not.toContain('/etc/couli/staging-payout.env');
  expect(prefix.indexOf(migration)).toBeGreaterThan(prefix.search(assignment));
  expect(prefix).not.toMatch(/\bdocker\s+compose\b.*\b(?:up|down|stop|restart|start|rm)\b/);
  // No open conditional can make migration optional while allowing the switch afterwards.
  let depth = 0;
  for (const line of gate.prefix) {
    if (/^if\s/.test(line)) depth++;
    if (/^fi(?:;|$)/.test(line)) depth--;
    if (line === migration) expect(depth).toBe(0);
  }
  expect(depth).toBe(0);
  expect(topLevel(gate.prefix)).toContain(migration);
});

it('[AC-B1-01zc-DEPLOY#2] 健康失败分支把 compose 的镜像变量恢复为切换前的值并重新启动', () => {
  const gate = healthGate();
  const variable = imageVariable();
  const failed = gate.failure.join('\n');
  const restore = new RegExp(
    `^(?:export\\s+)?${variable}="?\\$\\{?([A-Z_][A-Z0-9_]*)\\}?"?$`,
    'm',
  ).exec(failed);
  expect(restore, 'failure branch must restore the actual compose image variable').not.toBeNull();
  const previous = restore?.[1] ?? '';
  expect(previous).not.toBe(variable);
  const capture = new RegExp(
    `^(?:export\\s+)?${previous}=.*\\$\\((?:cat\\s|docker\\s+(?:image\\s+)?inspect\\s)`,
    'm',
  );
  const prefix = gate.prefix.join('\n');
  expect(prefix, 'previous image must come from persisted state or an existing container').toMatch(
    capture,
  );
  const previousAssignments = gate.prefix.filter((line) =>
    new RegExp(`^(?:export\\s+)?${previous}=`).test(line),
  );
  expect(previousAssignments).toHaveLength(1);
  const captured = previousAssignments[0] ?? '';
  const readState = /\$\(cat\s+([^()]+?)\)/.exec(captured);
  if (readState) {
    const values = assignments(gate.prefix);
    const state = expand(unquote((readState[1] ?? '').trim()), values);
    expect(state, 'persisted state must resolve to an absolute non-credential path').toMatch(/^\//);
    expect(state).not.toMatch(/\$|\s|[;&|<>]|\.env(?:$|\.)/);
    const writes = [...topLevel(gate.success), ...topLevel(gate.suffix)].flatMap((line) => {
      const write =
        /^(?:printf\s+(['"])%s\\n\1|echo)\s+("?\$\{?[A-Z_][A-Z0-9_]*\}?"?)\s*>\s*(.+)$/.exec(line);
      return write
        ? [{ value: unquote(write[2] ?? ''), path: expand(unquote(write[3] ?? ''), values) }]
        : [];
    });
    expect(
      writes.filter((write) => write.path === state),
      'successful deployment must update the SAME state file',
    ).toHaveLength(1);
    const saved = writes.find((write) => write.path === state)?.value ?? '';
    // Both read and write store the compose variable itself: a tag stays a tag, a full
    // reference stays a full reference. Saving PREV or a stale literal must fail.
    expect(saved.replace(/^\$\{?([A-Z_][A-Z0-9_]*)\}?$/, '$1')).toBe(variable);
    const successPath = [...topLevel(gate.success), ...topLevel(gate.suffix)];
    expect([...gate.success, ...gate.suffix].join('\n')).not.toMatch(
      new RegExp(`^(?:export\\s+)?${variable}=`, 'm'),
    );
    const saveIndex = successPath.findIndex(
      (line) => /^(?:printf|echo)\s.*>/.test(line) && expand(line, values).includes(state),
    );
    expect(successPath.slice(0, saveIndex).join('\n'), 'state write must be reachable').not.toMatch(
      /^(?:exit|return|exec)\b/m,
    );
    expect(
      [...gate.prefix, ...gate.failure].join('\n'),
      'never advance state before health success',
    ).not.toMatch(new RegExp(`>\\s*["']?${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    for (const line of [...gate.prefix, ...gate.failure]) {
      expect(expand(line, values)).not.toContain(`> ${state}`);
      expect(expand(line, values)).not.toContain(`> "${state}"`);
    }
  } else {
    expect(captured).toMatch(
      /\$\(docker\s+(?:image\s+)?inspect\s+.*(?:--format|-f)(?:=|\s+).*\{\{\s*\.Config\.Image\s*\}\}/,
    );
    // docker inspect returns a full reference; never feed it into repository:${TAG}.
    const image = string(record(services()['api'])['image']);
    expect(image).toMatch(new RegExp(`^(?:\\$${variable}|\\$\\{${variable}(?::\\?[^}]*)?\\})$`));
  }
  const rollback = gate.failure.find((line) => /^docker\s+compose\s+.*\bup\b/.test(line)) ?? '';
  expect(rollback).toMatch(/\bup\b.*--wait(?:\s|$)/);
  expect(rollback).toMatch(/--wait-timeout(?:=|\s+)[1-9]\d*/);
  expect(rollback).not.toMatch(/\|\||[;&]/);
  expect(failed.indexOf(rollback)).toBeGreaterThan(restore?.index ?? -1);
  expect(failed).toMatch(/^exit\s+[1-9]\d*$/m);
  const unconditionalFailure = topLevel(gate.failure);
  expect(unconditionalFailure).toContain(restore?.[0]);
  expect(
    gate.failure.filter((line) => new RegExp(`^(?:export\\s+)?${variable}=`).test(line)),
  ).toEqual([restore?.[0]]);
  expect([...gate.success, ...gate.failure, ...gate.suffix].join('\n')).not.toMatch(
    new RegExp(`^(?:export\\s+)?${previous}=`, 'm'),
  );
  expect(unconditionalFailure).toContain(rollback);
  expect(unconditionalFailure.findIndex((line) => /^exit\s+[1-9]\d*$/.test(line))).toBeGreaterThan(
    unconditionalFailure.indexOf(rollback),
  );
  expect(failed).not.toMatch(/^exit\s+0$/m);
  expect(topLevel(gate.failure).some((line) => /^exit\s+[1-9]\d*$/.test(line))).toBe(true);
  expect([...gate.prefix, gate.condition, ...gate.failure, ...gate.suffix].join('\n')).not.toMatch(
    /(?:db:migrate[^\n]*\bdown\b|migrate\.(?:ts|js)[^\n]*\bdown\b|docker\s+image\s+(?:rm|prune))/,
  );
});

it('[AC-B1-01zc-DEPLOY#3] 正向与回退都操作同一份 compose，覆盖全部五个进程', () => {
  const gate = healthGate();
  const activate = gate.condition.replace(/^if\s+(?:!\s+)?/, '').replace(/;\s*then$/, '');
  const rollback = gate.failure.find((line) => /^docker\s+compose\s+.*\bup\b/.test(line)) ?? '';
  const composePrefix = (line: string): string => line.split(/\s+up(?:\s|$)/)[0] ?? '';
  expect(composePrefix(activate)).toMatch(/^docker\s+compose\s+.*(?:-f|--file)(?:=|\s+)/);
  expect(composePrefix(rollback)).toBe(composePrefix(activate));
  expect(script().join('\n')).toContain('compose.yaml');
  for (const line of [activate, rollback]) {
    expect(line).not.toMatch(/--no-recreate|--no-start/);
    // No partial service list: pg-boss migrations require all process entries to restart.
    expect(line).not.toMatch(/(?:^|\s)(?:api|stream|worker|admin|payout)(?:\s|$)/);
    expect(line).toMatch(/(?:--force-recreate)\b/);
  }
});

it('[AC-B1-01zc-DEPLOY#4] 脚本只引用节点凭据文件，不打印内容或打开命令跟踪', () => {
  const text = asset('infra/staging/deploy.sh');
  script();
  const lines = statements(text);
  noInlineCredentials(text);
  const code = lines.join('\n');
  const values = new Map<string, string>();
  const helpers = lines
    .filter((line) => /^(?:function\s+)?[\w-]+\s*\(\)$/.test(line))
    .map((line) => line.replace(/^function\s+/, '').replace(/\s*\(\)$/, ''));
  for (const line of lines) {
    const expanded = expand(line, values);
    const readsNodeFile =
      /\b(?:cat|head|tail|sed|awk|tee|less|more)\b[^\n]*(?:staging(?:-payout|-migrator)?\.env|\/etc\/couli(?:\/|\b))/.test(
        expanded,
      ) || /<\s*["']?\/etc\/couli\//.test(expanded);
    const output = new RegExp(
      `^(?:echo|printf|cat|head|tail|sed|awk|tee|less|more|${helpers.join('|') || 'printf'})\\b`,
    ).test(line);
    if (readsNodeFile && output) {
      // A state-file write is allowed; printing the captured contents is not. Node files
      // may still be referenced by --env-file, assignment, or a quoted docker argument.
      expect(line, 'node file contents must not reach stdout/stderr').toMatch(
        /[^>]>(?![>&])\s*["']?(?:\/[^\s"']+|\$\{?[A-Z_][A-Z0-9_]*\}?)["']?$/,
      );
      expect(expanded).not.toMatch(/>\s*(?:&[12]|["']?\/dev\/(?:stdout|stderr))|\btee\b/);
    }
    for (const [name, value] of assignments([line])) values.set(name, expand(value, values));
    expect(line).not.toMatch(/^set\s+.*(?:\+e|\+o\s+errexit|-\w*x|\bxtrace\b)/);
  }
  expect(code).not.toMatch(
    /\b(?:echo|printf)\b[^\n]*\$\{?\w*(?:PASSWORD|SECRET|TOKEN|DATABASE.*URL|REDIS_URL|ENV_CONTENT)/i,
  );
  expect(code).not.toMatch(/^(?:env|printenv|export\s+-p|declare\s+-p|set\s*$)/m);
  expect(code).not.toMatch(/docker\s+compose\b[^\n]*\bconfig\b/);
  expect(code).not.toMatch(/docker\s+inspect\s+(?!--format\b|-f\b)/);
  expect(code).not.toMatch(/--env(?:=|\s)|(?:^|\s)-e\s+[A-Z_]+=/m);
  // Compose may use the shared file for interpolation. Only migration docker run
  // must reject it, because that step is allowed to receive migrator credentials only.
  for (const line of lines.filter((item) => /^docker\s+run\s/.test(item))) {
    expect(line).not.toMatch(/--env-file[^\n]*staging(?:-payout)?\.env/);
  }
  expect(code).toContain('/etc/couli/staging-migrator.env');
});
