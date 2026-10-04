// Rule tests added after the first rule-test review of B1-01k (规划/08 BR-ID-33「密文带 key_version，
// 支持轮换」「日志…中不得出现明文」; ADR-0001 §2 鉴权与密钥; §3 and §6 of
// apps/api/src/modules/platform/config/keyring-startup.ts), the part that needs no Nest:
// - the cipher openConfiguredFieldCrypto returns writes the keyring's current_version into its
//   own ciphertexts (parsed independently), decrypts them, has exactly the members of the
//   FieldCrypto contract and rotates (cipherProblems of wiring-kit.ts);
// - openConfiguredFieldCrypto prints nothing: run in a plain node process (wiring-child.ts) over
//   files holding a synthetic phone number, id number and key marker, stdout is exactly the
//   child's reply and stderr is empty.
// The same review's tests through the entries (FIELD_CRYPTO in every entry, the consumer module)
// live in wiring-nest.test.ts, which loads Nest once for all entry tests.
// Top-level it() only (规划/11 §4.3).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { openConfiguredFieldCrypto } from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import { SAMPLES, leaksIn, testKey } from './kit.ts';
import type { WiringChildReply, WiringChildRequest } from './wiring-child.ts';
import {
  KEYRINGS,
  cipherProblems,
  keyringDoc,
  localEnv,
  makeDir,
  removeDir,
  secretsOf,
  settle,
  writeFiles,
  type LocalFiles,
} from './wiring-kit.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

function fresh(label: string, contents: Parameters<typeof writeFiles>[1] = {}): LocalFiles {
  const dir = makeDir(label);
  dirs.push(dir);
  return writeFiles(dir, contents);
}

function local(files: LocalFiles) {
  return {
    provider: 'local',
    keyringFile: files.keyringFile,
    masterKeyFile: files.masterFile,
  } as const;
}

it('[BR-ID-33][ADR-0001 §2] openConfiguredFieldCrypto 返回的密码器：自己的密文带 keyring 的 current_version，能解自己的密文，方法集合完整，轮换（reencrypt）后明文与盲索引不变', async () => {
  const seen: Record<string, string[]> = {};
  for (const ring of KEYRINGS) {
    const files = fresh('r1-open', {
      keyring: JSON.stringify(keyringDoc({ versions: ring.versions, current: ring.current })),
    });
    const outcome = await settle(openConfiguredFieldCrypto('test', local(files)));
    seen[`${ring.versions.join('+')}@${ring.current}`] =
      'value' in outcome
        ? cipherProblems(outcome.value, ring.versions, ring.current)
        : ['rejected'];
  }
  expect(seen).toEqual({ '1+2@2': [], '1+2@1': [], '1+2+3@2': [] });
});

// ---- nothing printed by the opener --------------------------------------------------------------

const CHILD = fileURLToPath(new URL('./wiring-child.ts', import.meta.url));

/** A key-looking marker derived by code (no literal): 64 hex characters. */
function keyMarker(): string {
  return testKey(97).toString('hex');
}

function runChild(request: WiringChildRequest): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly reply: WiringChildReply | string;
} {
  const run = spawnSync(process.execPath, [CHILD], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env['PATH'] ?? '' },
  });
  let reply: WiringChildReply | string;
  try {
    reply = JSON.parse(run.stdout) as WiringChildReply;
  } catch {
    reply = 'stdout is not one JSON reply';
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, reply };
}

it('[BR-ID-33] openConfiguredFieldCrypto 与 loadConfig 在独立进程里成功、失败都不打印任何东西：stdout 正好是回复、stderr 为空，文件里的手机号、身份证号与密钥标记哪里都找不到', () => {
  const marker = keyMarker();
  const planted = { phone: SAMPLES.phone, id_no: SAMPLES.idNo, marker };
  const withPlanted = JSON.stringify({ ...keyringDoc(), ...planted });
  const files = {
    ok: fresh('r1-child-ok', { keyring: withPlanted }),
    notKeyring: fresh('r1-child-not-keyring', { keyring: JSON.stringify(planted) }),
    notJson: fresh('r1-child-not-json', {
      keyring: `phone=${SAMPLES.phone} id=${SAMPLES.idNo} key=${marker}`,
    }),
    masterPhone: fresh('r1-child-master', { master: `${SAMPLES.phone}${SAMPLES.idNo}\n` }),
    masterMarkerUpper: fresh('r1-child-master-upper', { master: `${marker.toUpperCase()}\n` }),
    otherMaster: fresh('r1-child-other', {
      master: `${marker}\n`,
      keyring: withPlanted,
    }),
  };
  const request: WiringChildRequest = {
    open: [
      { appEnv: 'test', keyring: local(files.ok) },
      { appEnv: 'local', keyring: local(files.ok) },
      { appEnv: 'test', keyring: local(files.notKeyring) },
      { appEnv: 'test', keyring: local(files.notJson) },
      { appEnv: 'test', keyring: local(files.masterPhone) },
      { appEnv: 'test', keyring: local(files.masterMarkerUpper) },
      { appEnv: 'test', keyring: local(files.otherMaster) },
      { appEnv: 'test', keyring: { ...local(files.ok), keyringFile: `${files.ok.dir}/none.json` } },
      { appEnv: 'test', keyring: { ...local(files.ok), masterKeyFile: files.ok.dir } },
      { appEnv: 'prod', keyring: local(files.ok) },
      { appEnv: 'staging', keyring: { provider: 'kms', keyringFile: files.ok.keyringFile } },
    ],
    config: [
      {
        APP_ENV: 'prod',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_KEYRING_FILE: `/srv/${SAMPLES.phone}`,
        FIELD_MASTER_KEY_FILE: `/srv/${marker}`,
      },
      { APP_ENV: 'test', FIELD_KEY_PROVIDER: SAMPLES.idNo, FIELD_KEYRING_FILE: marker },
      { APP_ENV: 'test', FIELD_KEYRING_FILE: `/srv/${SAMPLES.idNo}` },
      localEnv('test', files.ok),
    ],
    plaintexts: [SAMPLES.phone, SAMPLES.idNo, marker],
  };
  const run = runChild(request);
  const opened = { opened: true, currentKeyVersion: 2, roundTrips: true, blindIndexStable: true };
  const refused = (code: string) => ({ code, exact: true });
  expect(run.reply).toEqual({
    open: [
      opened,
      opened,
      refused('keyring_invalid'),
      refused('keyring_invalid'),
      refused('master_key_invalid'),
      refused('master_key_invalid'),
      refused('unwrap_failed'),
      refused('keyring_unreadable'),
      refused('master_key_unreadable'),
      refused('local_in_cloud'),
      refused('kms_unavailable'),
    ],
    config: [1, 1, 1, -1],
  });
  expect({
    status: run.status,
    stderr: run.stderr,
    exact: run.stdout === JSON.stringify(run.reply),
  }).toEqual({
    status: 0,
    stderr: '',
    exact: true,
  });
  const secrets = {
    ...secretsOf(files.ok),
    phone: SAMPLES.phone,
    'id number': SAMPLES.idNo,
    'key marker': marker,
    'key marker bytes': testKey(97),
  };
  expect(leaksIn(`${run.stdout}\n${run.stderr}`, secrets)).toEqual([]);
});
