import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { asset } from './kit.ts';

// Container-only command fixtures: execute the deployment control flow with a fake Docker,
// no daemon, network, node credentials or database. Only absolute resource paths are relocated;
// all conditions, state writes and compose selection remain the production script's own code.
const CREDENTIAL = 'synthetic_dirty_recovery_password';
const SAVED = '# previously successful compose\n';
const EDITED = '# edited compose that caused a restart\n';
const DOCKER = `#!/bin/bash
set -eu
case "$1 $2" in
  'image inspect') exit 0 ;;
  'image ls') printf '%s\\n' "$COULI_API_TAG"; exit 0 ;;
  'image rm') exit 0 ;;
esac
case "$1" in
  run) printf 'migrate\\n' >> "$FAKE_TRACE"; exit 0 ;;
  inspect) printf '%s\\n' $FAKE_COUNTS; exit 0 ;;
  compose)
    shift
    compose=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -f|--file) compose="$2"; shift 2 ;;
        --env-file) shift 2 ;;
        up)
          test -f "$compose"
          printf 'up|%s|%s\\n' "$COULI_API_TAG" "$compose" >> "$FAKE_TRACE"
          exit 0 ;;
        ps) printf 'fixture-container\\n'; exit 0 ;;
        exec) exit 0 ;;
        *) printf 'unsupported fake compose command\\n' >&2; exit 93 ;;
      esac
    done ;;
esac
printf 'unsupported fake docker command\\n' >&2
exit 93
`;

interface Result {
  status: number | null;
  output: string;
  calls: string[];
}

function fixture(run: (directory: string) => void): void {
  const parent = resolve('.tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'dirty-recovery-'));
  try {
    mkdirSync(join(directory, 'bin'));
    mkdirSync(join(directory, 'state'));
    let script = asset('infra/staging/deploy.sh')
      .replaceAll('/var/lib/couli', './state')
      .replaceAll('/run/lock', './locks');
    const nodeFiles = [
      '/etc/couli/staging.env',
      '/etc/couli/staging-payout.env',
      '/etc/couli/staging-migrator.env',
      '/etc/pki/ca.crt',
      '/etc/couli-keys/master.key',
      '/etc/couli-keys/keyring.json',
      '/etc/couli-jwt/es256.pem',
      '/etc/couli-jwt/key-id',
    ];
    for (const [index, path] of nodeFiles.entries()) {
      const name = `node-${index}.fixture`;
      script = script.replaceAll(path, `./${name}`);
      // Plain synthetic text, not an env file, key or certificate.
      writeFileSync(join(directory, name), `password=${CREDENTIAL}\n`);
    }
    writeFileSync(join(directory, 'deploy.sh'), script);
    writeFileSync(join(directory, 'compose.yaml'), EDITED);
    writeFileSync(join(directory, 'bin/docker'), DOCKER, { mode: 0o755 });
    writeFileSync(join(directory, 'bin/flock'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function seed(directory: string, tag: string, switched: boolean): void {
  writeFileSync(join(directory, 'state/staging-api.tag'), `${tag}\n`);
  writeFileSync(join(directory, `state/compose.${tag}.yaml`), SAVED);
  if (switched) writeFileSync(join(directory, 'state/staging-api.switched'), `${tag}\n`);
}

function deploy(directory: string, tag: string, restarts: boolean): Result {
  const trace = join(directory, 'calls');
  writeFileSync(trace, '');
  const result = spawnSync('/bin/bash', [join(directory, 'deploy.sh'), tag], {
    cwd: directory,
    // Do not inherit developer credentials or shell startup hooks.
    env: {
      PATH: `${join(directory, 'bin')}:/usr/bin:/bin`,
      LC_ALL: 'C',
      FAKE_TRACE: trace,
      FAKE_COUNTS: restarts ? '0 0 1 0 0' : '0 0 0 0 0',
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error, 'fixture process must finish normally').toBeUndefined();
  expect(result.signal).toBeNull();
  const output = result.stdout + result.stderr;
  expect(output.includes(CREDENTIAL), 'stdout and stderr must never contain a password').toBe(
    false,
  );
  expect(output).not.toContain('unsupported fake');
  expect(output).not.toMatch(/command not found|syntax error/);
  return {
    status: result.status,
    output,
    calls: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
  };
}

function failedRedeploy(directory: string): Result {
  seed(directory, 'T', true);
  const failure = deploy(directory, 'T', true);
  expect(failure.status).toBe(1);
  expect(failure.calls).toEqual(['migrate', `up|T|${join(directory, 'compose.yaml')}`]);
  expect(failure.output).toContain('RestartCount');
  expect(readFileSync(join(directory, 'state/staging-api.tag'), 'utf8').trim()).toBe('T');
  expect(readFileSync(join(directory, 'state/compose.T.yaml'), 'utf8')).toBe(SAVED);
  return failure;
}

it('[AC-B1-01zr#1] 当前标签重启失败标记不确定并提示显式回退，全新环境仍能重试', () => {
  fixture((directory) => {
    // No successful tag or snapshot: this exception must not strand a fresh installation.
    const first = deploy(directory, 'T', true);
    expect(first.status).toBe(1);
    expect(existsSync(join(directory, 'state/compose.T.yaml'))).toBe(false);
    const retry = deploy(directory, 'T', false);
    expect(retry.status).toBe(0);
    expect(retry.calls).toContain(`up|T|${join(directory, 'compose.yaml')}`);
  });
  fixture((directory) => {
    const failure = failedRedeploy(directory);
    const switched = join(directory, 'state/staging-api.switched');
    const running = existsSync(switched) ? readFileSync(switched, 'utf8').trim() : '';
    // Removal, empty state or a dirty sentinel are equivalent unknown-running states.
    expect(running, 'a failed same-tag switch must no longer claim T is settled').not.toBe('T');
    expect(failure.output, 'name an explicit rollback mode or the saved compose').toMatch(
      /--rollback|compose\.T\.yaml/,
    );
  });
}, 60_000);

it('[AC-B1-01zr#2] dirty 后同标签部署使用保存副本，恢复成功后才允许采用新 compose', () => {
  fixture((directory) => {
    failedRedeploy(directory);
    const recovered = deploy(directory, 'T', false);
    expect(recovered.status).toBe(0);
    expect(recovered.calls).toEqual(['migrate', 'up|T|./state/compose.T.yaml']);
    expect(readFileSync(join(directory, 'state/compose.T.yaml'), 'utf8')).toBe(SAVED);
    const next = deploy(directory, 'T', false);
    expect(next.status).toBe(0);
    expect(next.calls).toContain(`up|T|${join(directory, 'compose.yaml')}`);
  });
}, 60_000);

it('[AC-B1-01zr#3] dirty 后请求标签缺少保存副本时说明原因，在迁移和切换之前拒绝', () => {
  for (const tag of ['T', 'another-tag']) {
    fixture((directory) => {
      failedRedeploy(directory);
      if (tag === 'T') rmSync(join(directory, 'state/compose.T.yaml'));
      const refused = deploy(directory, tag, false);
      expect(refused.status).not.toBe(0);
      expect(refused.calls, 'never migrate or switch using the edited local compose').toEqual([]);
      expect(refused.output).toMatch(/compose/i);
      expect(refused.output).toMatch(/missing|not found|no .*saved|不存在|未.*(?:保存|找到)|缺少/i);
      expect(readFileSync(join(directory, 'state/staging-api.tag'), 'utf8').trim()).toBe('T');
    });
  }
}, 60_000);

it('[AC-B1-01zr#4] 旧版现场没有切换记录时不假定上一成功标签仍在跑，选择保存副本', () => {
  fixture((directory) => {
    seed(directory, 'A', false);
    expect(existsSync(join(directory, 'state/staging-api.switched'))).toBe(false);
    const result = deploy(directory, 'A', false);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(['migrate', 'up|A|./state/compose.A.yaml']);
    expect(readFileSync(join(directory, 'state/compose.A.yaml'), 'utf8')).toBe(SAVED);
  });
}, 30_000);
