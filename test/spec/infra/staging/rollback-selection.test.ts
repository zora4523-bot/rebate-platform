import { expect, it } from 'vitest';
import { asset, imageVariable, sourceLines } from './kit.ts';

// Static audit only: never execute deploy.sh or read node credentials. Keep the existing
// DEPLOY tests' direct, top-level deployment workflow. File selection uses a multiline if.
function fileSelection(): { before: string; found: string; missing: string; after: string } {
  const lines = sourceLines(asset('infra/staging/deploy.sh')).map((line) =>
    line.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, '$$$1'),
  );
  const tag = imageVariable();
  const switchIndex = lines.findIndex((line) => /^if\s+docker compose\b.*\bup\b/.test(line));
  expect(switchIndex, 'must select the file before the health-gated switch').toBeGreaterThan(0);
  const prefix = lines.slice(0, switchIndex);
  const condition = `if [[ -f "$STATE_DIR/compose.$${tag}.yaml" ]]; then`;
  const start = prefix.indexOf(condition);
  expect(start, 'check the saved compose for the requested tag, not PREVIOUS_TAG').toBeGreaterThan(
    0,
  );
  const branches: [string[], string[]] = [[], []];
  let branch: 0 | 1 = 0;
  let depth = 1;
  let end = -1;
  for (let index = start + 1; index < prefix.length; index++) {
    const line = prefix[index] ?? '';
    if (/^if\s/.test(line)) depth++;
    if (line === 'fi') depth--;
    if (depth === 0) {
      end = index;
      break;
    }
    if (depth === 1 && line === 'else') {
      branch = 1;
    } else {
      branches[branch].push(line);
    }
  }
  expect(end, 'file selection must close before the switch').toBeGreaterThan(start);
  expect(lines[switchIndex]).toMatch(/docker compose -f "\$COMPOSE_FILE" .*\bup\b/);
  return {
    before: prefix.slice(0, start).join('\n'),
    found: branches[0].join('\n'),
    missing: branches[1].join('\n'),
    after: prefix.slice(end + 1).join('\n'),
  };
}

it('[AC-B1-01zj#1] 手动按标签回退优先使用该标签保存的 compose 副本', () => {
  const selection = fileSelection();
  expect(selection.before).toMatch(/^STATE_DIR=["']?\/var\/lib\/couli["']?$/m);
  expect(selection.found).toContain(`COMPOSE_FILE="$STATE_DIR/compose.$${imageVariable()}.yaml"`);
  // A subsequent reset to the script's compose would silently undo the selection.
  expect(selection.after).not.toMatch(/^(?:export\s+)?COMPOSE_FILE=/m);
  expect(selection.found).not.toMatch(/^(?:exit|return)\b/m);
});

it('[AC-B1-01zj#2] 指定标签没有 compose 副本时保留脚本旁文件并输出说明', () => {
  const selection = fileSelection();
  expect(selection.before).toMatch(/^COMPOSE_FILE=.*dirname.*\$0.*\/compose\.yaml"?$/m);
  expect(selection.missing, 'fallback must not select a nonexistent snapshot').not.toMatch(
    /^COMPOSE_FILE=.*compose\.\$/m,
  );
  expect(selection.missing).not.toMatch(/^(?:exit|return)\b/m);
  const messages = selection.missing
    .split('\n')
    .filter((line) => /^(?:log|printf|echo)\s/.test(line))
    .join('\n');
  expect(messages, 'tell the operator no saved compose exists').toMatch(
    /no .*compose.*saved|no .*saved.*compose|没有.*(?:compose|副本)|未.*(?:保存|找到)/i,
  );
  expect(messages, 'identify the current compose fallback').toMatch(
    /(?:current|local|当前|脚本旁).*compose\.yaml/i,
  );
  expect(selection.after).not.toMatch(/^(?:export\s+)?COMPOSE_FILE=/m);
});

it('[AC-B1-01zj#3] 重启计数失败提示与 README 如实说明手动回退及完整竞态窗口', () => {
  // Task-authorized exception: frozen DEPLOY#2 forbids *any* image-variable assignment
  // inside gate.success, including its RestartCount failure branch. It also requires a
  // single direct health conditional and direct rollback in gate.failure. Do not change
  // those frozen tests or require the incompatible inline automatic restore here.
  const readme = asset('infra/staging/README.md').replace(/[`*]/g, '');
  expect(readme, 'the window begins when ANY service first becomes healthy').toMatch(
    /(?:任一|任何一个|某个|首个)服务首次健康后.{0,80}(?:到|至)\s*up --wait\s*返回/,
  );
  expect(readme).not.toMatch(/崩溃恰好发生在\s*up --wait\s*返回之后的那一刻/);
  expect(readme).not.toMatch(/在其他进程还没健康之前也会被发现/);
  expect(readme).toMatch(/RestartCount[^\n]*不记录标签[^\n]*非零退出[^\n]*手动回退/);
  const lines = sourceLines(asset('infra/staging/deploy.sh'));
  const start = lines.findIndex((line) => /^if\s.*\$RESTART_COUNTS.*!=/.test(line));
  expect(start).toBeGreaterThan(0);
  const end = lines.findIndex((line, index) => index > start && line === 'fi');
  expect(end).toBeGreaterThan(start);
  const failure = lines.slice(start + 1, end).join('\n');
  expect(failure).toMatch(/^(?:fail|log|printf|echo)\s.*RestartCount/m);
  expect(failure).toMatch(/deploy\.sh\s+\$\{?PREVIOUS_TAG/);
  expect(failure).toMatch(/^exit\s+[1-9]\d*$/m);
  expect(failure).not.toMatch(/>\s*"?\$STATE_FILE|\b(?:cp|rm|touch)\s/);
});
