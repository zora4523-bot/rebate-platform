import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { asset } from './kit.ts';

// B1-01zza task comments define these local AC identifiers. Run only in the orchestrator's
// container: relocate node paths and stub Docker/flock, preserving deploy.sh's control flow.
// No real node env files, keys, certificates, Docker daemon or network are used.
const CREDENTIAL = 'synthetic_current_compose_password';
const CURRENT = '# operator-restored current compose\n';
const SAVED = '# saved compose for the requested tag\n';
const DOCKER = `#!/bin/bash
set -eu
case "$1 $2" in
  'image inspect') exit 0 ;;
  'image ls') printf '%s\\n' "$COULI_API_TAG"; exit 0 ;;
  'image rm') printf 'remove-image\\n' >> "$FAKE_TRACE"; exit 0 ;;
esac
case "$1" in
  run) printf 'migrate\\n' >> "$FAKE_TRACE"; exit 0 ;;
  inspect) printf '0\\n0\\n0\\n0\\n0\\n'; exit 0 ;;
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
        exec) printf 'settle\\n' >> "$FAKE_TRACE"; exit 0 ;;
        *) printf 'unsupported fake compose command\\n' >&2; exit 93 ;;
      esac
    done ;;
esac
printf 'unsupported fake docker command\\n' >&2
exit 93
`;

interface State {
  previous?: string;
  switched?: string;
  saved?: string;
}

function fixture(state: State, run: (directory: string) => void): void {
  const parent = resolve('.tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'current-compose-'));
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
      // Plain synthetic text, not an actual env file, key or certificate.
      writeFileSync(join(directory, name), `password=${CREDENTIAL}\n`);
    }
    writeFileSync(join(directory, 'deploy.sh'), script);
    writeFileSync(join(directory, 'compose.yaml'), CURRENT);
    writeFileSync(join(directory, 'bin/docker'), DOCKER, { mode: 0o755 });
    writeFileSync(join(directory, 'bin/flock'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    if (state.previous !== undefined) {
      writeFileSync(join(directory, 'state/staging-api.tag'), `${state.previous}\n`);
    }
    if (state.switched !== undefined) {
      writeFileSync(join(directory, 'state/staging-api.switched'), `${state.switched}\n`);
    }
    if (state.saved !== undefined) {
      writeFileSync(join(directory, `state/compose.${state.saved}.yaml`), SAVED);
    }
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function deploy(directory: string, tag: string) {
  const trace = join(directory, 'calls');
  writeFileSync(trace, '');
  const result = spawnSync(
    '/bin/bash',
    [join(directory, 'deploy.sh'), tag, '--with-current-compose'],
    {
      cwd: directory,
      // Never inherit developer credentials or shell startup hooks.
      env: {
        PATH: `${join(directory, 'bin')}:/usr/bin:/bin`,
        LC_ALL: 'C',
        FAKE_TRACE: trace,
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  expect(result.error, 'fixture must finish without a spawn error or timeout').toBeUndefined();
  expect(result.signal).toBeNull();
  const output = result.stdout + result.stderr;
  expect(output, 'neither stdout nor stderr may expose a password').not.toContain(CREDENTIAL);
  expect(output).not.toMatch(/unsupported fake|command not found|syntax error/);
  return {
    status: result.status,
    output,
    calls: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
  };
}

function expectRefused(directory: string, tag: string, reason: RegExp): void {
  const result = deploy(directory, tag);
  expect(result.status, 'inapplicable confirmation must exit 2, not silently deploy').toBe(2);
  expect(result.calls, 'reject before migration, switching or settling any container').toEqual([]);
  expect(result.output, 'identify the rejected option').toContain('--with-current-compose');
  expect(result.output, 'explain why the option does not apply').toMatch(reason);
}

it('[AC-B1-01zza#1] 非 dirty 现场无论回退或重部署、有无副本，都在迁移前拒绝参数', () => {
  const states: State[] = [
    { previous: 'v2', switched: 'v2', saved: 'v1' },
    { previous: 'v1', switched: 'v1', saved: 'v1' },
    { previous: 'v1', switched: 'v1' },
    // An absent switch record on a legacy node is not the explicit dirty marker.
    { previous: 'v1' },
  ];
  for (const state of states) {
    fixture(state, (directory) => {
      expectRefused(directory, 'v1', /uncertain|dirty|不确定/i);
    });
  }
}, 180_000);

it('[AC-B1-01zza#2] 全新节点没有上一成功标签时拒绝确认参数，迁移前退出 2', () => {
  fixture({}, (directory) => {
    expectRefused(directory, 'v1', /last.*successful|previous|上一.*成功|上一个.*标签/i);
  });
}, 60_000);

it('[AC-B1-01zza#3] dirty 的上一成功标签已有副本时拒绝参数，仅无副本时允许恢复', () => {
  fixture({ previous: 'v1', switched: '-uncertain-', saved: 'v1' }, (directory) => {
    expectRefused(directory, 'v1', /saved|snapshot|副本|保存/i);
  });
  // Positive control is part of this red case, not a standalone green test in the red manifest.
  // A blanket rejection must not strand legacy nodes with no saved compose.
  fixture({ previous: 'v1', switched: '-uncertain-' }, (directory) => {
    const result = deploy(directory, 'v1');
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      'migrate',
      `up|v1|${join(directory, 'compose.yaml')}`,
      ...Array<string>(5).fill('settle'),
    ]);
    expect(result.output).toMatch(/warning|警告/i);
    expect(readFileSync(join(directory, 'state/compose.v1.yaml'), 'utf8')).toBe(CURRENT);
    expect(readFileSync(join(directory, 'state/staging-api.tag'), 'utf8').trim()).toBe('v1');
    expect(readFileSync(join(directory, 'state/staging-api.switched'), 'utf8').trim()).toBe('v1');
  });
}, 90_000);

it('[AC-B1-01zza#4] dirty 时其他标签无论有无副本都不得带确认参数，迁移前退出 2', () => {
  const states: State[] = [
    { previous: 'v2', switched: '-uncertain-', saved: 'v1' },
    { previous: 'v2', switched: '-uncertain-' },
  ];
  for (const state of states) {
    fixture(state, (directory) => {
      expectRefused(
        directory,
        'v1',
        /last.*successful|previous|上一.*成功|上一个.*标签|saved|副本/i,
      );
    });
  }
}, 90_000);
