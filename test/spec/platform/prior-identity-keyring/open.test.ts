// Rule tests: opening the second field keyring, the independent data keys of the isolated store of
// prior identities (规划/08 BR-ID-25 细则「旧身份留存」:「隔离存储用独立的数据密钥」; 规划/04 §3.2
// 「实名更正旧身份」行; ADR-0001 §2 鉴权与密钥; 规划/11 §8), called directly: §4 of
// apps/api/src/modules/platform/config/keyring-prior-identity.ts. Expected keys and ciphertexts
// come from the reference functions of ../crypto/kit.ts, never from the implementation; the main
// keyring is opened by the existing openConfiguredFieldCrypto. Top-level it() only (规划/11 §4.3).
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import {
  openPriorIdentityFieldCrypto,
  type PriorIdentityKeyringErrorCode,
} from '../../../../apps/api/src/modules/platform/config/keyring-prior-identity.ts';
import { openConfiguredFieldCrypto } from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import { BLIND_KEY_LABEL, SAMPLES, leaksIn, testKey } from '../crypto/kit.ts';
import {
  MASTER_LABEL,
  OTHER_MASTER_LABEL,
  keyringDoc,
  masterText,
  settle,
} from '../crypto/wiring-kit.ts';
import type { PriorChildReply, PriorChildRequest } from './child.ts';
import {
  KEYRING_LIMIT,
  PRIOR_MASTER_LABEL,
  PRIOR_MESSAGES,
  PRIOR_OTHER_MASTER_LABEL,
  fieldLocal,
  generatedCipherProblems,
  makeDir,
  priorCipherProblems,
  priorDoc,
  priorErrorProblems,
  priorLocal,
  priorMasterText,
  priorSecretsOf,
  removeDir,
  separationProblems,
  writePriorFiles,
  type PriorFiles,
} from './kit.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

function fresh(label: string, contents: Parameters<typeof writePriorFiles>[1] = {}): PriorFiles {
  const dir = makeDir(label);
  dirs.push(dir);
  return writePriorFiles(dir, contents);
}

function explain(value: unknown): string {
  return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

/** Problems of an opening that must reject with exactly `code` (['resolved'] when it opened). */
async function rejectionProblems(
  promise: Promise<unknown>,
  code: PriorIdentityKeyringErrorCode,
): Promise<string[]> {
  const outcome = await settle(promise);
  return 'error' in outcome ? priorErrorProblems(outcome.error, code) : ['resolved'];
}

/** A local keyring config whose files do not exist (a step that reads them fails). */
function missing(files: PriorFiles): {
  readonly provider: 'local';
  readonly keyringFile: string;
  readonly masterKeyFile: string;
} {
  return {
    provider: 'local',
    keyringFile: join(files.dir, 'none.json'),
    masterKeyFile: join(files.dir, 'none.hex'),
  };
}

const RINGS = [
  { versions: [1, 2], current: 2 },
  { versions: [1, 2], current: 1 },
  { versions: [1, 2, 3], current: 2 },
] as const;

it('[AC-B1-27e#14][BR-ID-25][规划/11 §8] local 与 test 没配这一组时生成一套只在本次有效的密钥环：可用的 FieldCrypto（当前版本 1），不读任何文件，也不看主密钥环', async () => {
  const files = fresh('generated');
  const mains = {
    'no main keyring': null,
    'main keyring files missing': missing(files),
    'main keyring': fieldLocal(files),
  } as const;
  const seen: Record<string, string[]> = {};
  for (const appEnv of ['local', 'test'] as const) {
    for (const [label, keyring] of Object.entries(mains)) {
      const outcome = await settle(openPriorIdentityFieldCrypto(appEnv, null, keyring));
      seen[`${appEnv}: ${label}`] =
        'value' in outcome
          ? generatedCipherProblems(outcome.value)
          : [`rejected: ${explain(outcome.error)}`];
    }
  }
  expect(seen).toEqual({
    'local: no main keyring': [],
    'local: main keyring files missing': [],
    'local: main keyring': [],
    'test: no main keyring': [],
    'test: main keyring files missing': [],
    'test: main keyring': [],
  });
});

it('[AC-B1-27e#15][BR-ID-25] 生成的密钥环每次都不同，与主密钥环的密文互相解不开（数据密钥独立）', async () => {
  const files = fresh('generated-apart');
  const first = await settle(openPriorIdentityFieldCrypto('test', null, null));
  const second = await settle(openPriorIdentityFieldCrypto('test', null, fieldLocal(files)));
  const main = await settle(openConfiguredFieldCrypto('test', fieldLocal(files)));
  expect('value' in main ? 'opened' : explain(main.error)).toBe('opened');
  expect({
    first: 'value' in first ? 'opened' : explain(first.error),
    second: 'value' in second ? 'opened' : explain(second.error),
  }).toEqual({ first: 'opened', second: 'opened' });
  if (!('value' in first) || !('value' in second) || !('value' in main)) return;
  expect({
    'first and second': separationProblems(first.value, second.value),
    'first and main': separationProblems(first.value, main.value),
    'second and main': separationProblems(second.value, main.value),
  }).toEqual({ 'first and second': [], 'first and main': [], 'second and main': [] });
});

it('[AC-B1-27e#16][BR-ID-25][规划/02 §12.6] staging 与 prod 没配这一组时以 not_configured 拒绝，不读任何文件', async () => {
  const files = fresh('not-configured');
  const seen: Record<string, string[]> = {};
  for (const appEnv of ['staging', 'prod'] as const) {
    seen[`${appEnv}: no main keyring`] = await rejectionProblems(
      openPriorIdentityFieldCrypto(appEnv, null, null),
      'not_configured',
    );
    seen[`${appEnv}: main keyring files missing`] = await rejectionProblems(
      openPriorIdentityFieldCrypto(appEnv, null, missing(files)),
      'not_configured',
    );
  }
  expect(seen).toEqual({
    'staging: no main keyring': [],
    'staging: main keyring files missing': [],
    'prod: no main keyring': [],
    'prod: main keyring files missing': [],
  });
});

it('[AC-B1-27e#17][BR-ID-25] 配了 local 组时返回这套密钥环的 FieldCrypto：密文带 current_version、各版本可解可重加密、盲索引用它自己的键，且与主密钥环互相解不开', async () => {
  const seen: Record<string, string[]> = {};
  for (const appEnv of ['local', 'test', 'staging'] as const) {
    for (const ring of RINGS) {
      const files = fresh(`open-${appEnv}`, {
        keyring: JSON.stringify(priorDoc({ versions: ring.versions, current: ring.current })),
      });
      const label = `${appEnv} ${ring.versions.join('+')}@${String(ring.current)}`;
      const outcome = await settle(
        openPriorIdentityFieldCrypto(appEnv, priorLocal(files), fieldLocal(files)),
      );
      const main = await settle(openConfiguredFieldCrypto('test', fieldLocal(files)));
      seen[label] =
        'value' in outcome && 'value' in main
          ? [
              ...priorCipherProblems(outcome.value, ring.versions, ring.current),
              ...separationProblems(outcome.value, main.value),
            ]
          : ['error' in outcome ? `rejected: ${explain(outcome.error)}` : 'main did not open'];
    }
  }
  const files = fresh('open-no-main');
  const withoutMain = await settle(openPriorIdentityFieldCrypto('test', priorLocal(files), null));
  seen['test without a main keyring'] =
    'value' in withoutMain
      ? priorCipherProblems(withoutMain.value, [1, 2], 2)
      : [`rejected: ${explain(withoutMain.error)}`];
  const kmsMain = await settle(
    openPriorIdentityFieldCrypto('staging', priorLocal(files), {
      provider: 'kms',
      keyringFile: files.fieldKeyringFile,
    }),
  );
  seen['staging with a kms main keyring'] =
    'value' in kmsMain
      ? priorCipherProblems(kmsMain.value, [1, 2], 2)
      : [`rejected: ${explain(kmsMain.error)}`];
  expect(seen).toEqual(Object.fromEntries(Object.keys(seen).map((key) => [key, []])));
  expect(Object.keys(seen)).toHaveLength(11);
});

it('[AC-B1-27e#18][ADR-0001 §2][规划/02 §12.6] prod 用 local 以 local_in_cloud 拒绝、kms 以 kms_unavailable 拒绝，都不读文件', async () => {
  const files = fresh('cloud');
  const seen: Record<string, string[]> = {
    'prod local, files missing': await rejectionProblems(
      openPriorIdentityFieldCrypto('prod', missing(files), null),
      'local_in_cloud',
    ),
    'prod local, files present': await rejectionProblems(
      openPriorIdentityFieldCrypto('prod', priorLocal(files), fieldLocal(files)),
      'local_in_cloud',
    ),
  };
  for (const appEnv of ['test', 'staging', 'prod'] as const) {
    seen[`${appEnv} kms`] = await rejectionProblems(
      openPriorIdentityFieldCrypto(
        appEnv,
        { provider: 'kms', keyringFile: join(files.dir, 'none.json') },
        null,
      ),
      'kms_unavailable',
    );
  }
  expect(seen).toEqual({
    'prod local, files missing': [],
    'prod local, files present': [],
    'test kms': [],
    'staging kms': [],
    'prod kms': [],
  });
});

it('[AC-B1-27e#19][ADR-0001 §2] 旧身份主密钥文件：读不了是 master_key_unreadable，内容不是 64 个小写十六进制（可带一个换行）是 master_key_invalid，先于 keyring 文件检查', async () => {
  const hex = testKey(PRIOR_MASTER_LABEL).toString('hex');
  const cases: {
    readonly label: string;
    readonly code: PriorIdentityKeyringErrorCode;
    readonly contents?: Parameters<typeof writePriorFiles>[1];
    readonly edit?: (files: PriorFiles) => Partial<ReturnType<typeof priorLocal>>;
  }[] = [
    {
      label: '/dev/null',
      code: 'master_key_unreadable',
      edit: () => ({ masterKeyFile: '/dev/null' }),
    },
    {
      label: 'a directory',
      code: 'master_key_unreadable',
      edit: (files) => ({ masterKeyFile: files.dir }),
    },
    {
      label: 'no file',
      code: 'master_key_unreadable',
      edit: (files) => ({ masterKeyFile: join(files.dir, 'none.hex') }),
    },
    { label: 'upper case', code: 'master_key_invalid', contents: { master: hex.toUpperCase() } },
    { label: 'CRLF', code: 'master_key_invalid', contents: { master: `${hex}\r\n` } },
    { label: '63 characters', code: 'master_key_invalid', contents: { master: hex.slice(1) } },
    { label: 'two line feeds', code: 'master_key_invalid', contents: { master: `${hex}\n\n` } },
    {
      label: 'invalid master and no keyring file',
      code: 'master_key_invalid',
      contents: { master: `${hex} ` },
      edit: (files) => ({ keyringFile: join(files.dir, 'none.json') }),
    },
  ];
  const seen: Record<string, string[]> = {};
  for (const item of cases) {
    const files = fresh('master', item.contents ?? {});
    const prior = { ...priorLocal(files), ...(item.edit?.(files) ?? {}) };
    seen[item.label] = await rejectionProblems(
      openPriorIdentityFieldCrypto('test', prior, fieldLocal(files)),
      item.code,
    );
  }
  const plain = fresh('master-plain', { master: hex });
  const opened = await settle(
    openPriorIdentityFieldCrypto('test', priorLocal(plain), fieldLocal(plain)),
  );
  seen['without the line feed'] =
    'value' in opened ? priorCipherProblems(opened.value, [1, 2], 2) : [explain(opened.error)];
  expect(seen).toEqual(Object.fromEntries(Object.keys(seen).map((key) => [key, []])));
  expect(Object.keys(seen)).toHaveLength(cases.length + 1);
});

it('[AC-B1-27e#20][ADR-0001 §2] 旧身份 keyring 文件：读不了是 keyring_unreadable，不是该主密钥的合法 keyring 是 keyring_invalid，解不开是 unwrap_failed；上限 1 MiB', async () => {
  const doc = JSON.stringify(priorDoc());
  const notUtf8 = Buffer.from(JSON.stringify({ ...priorDoc(), note: 'X' }), 'utf8');
  notUtf8[notUtf8.indexOf('"note":"X"') + '"note":"'.length] = 0x80;
  const cases: {
    readonly label: string;
    readonly code: PriorIdentityKeyringErrorCode;
    readonly contents?: Parameters<typeof writePriorFiles>[1];
    readonly edit?: (files: PriorFiles) => Partial<ReturnType<typeof priorLocal>>;
  }[] = [
    {
      label: 'no file',
      code: 'keyring_unreadable',
      edit: (files) => ({ keyringFile: join(files.dir, 'none.json') }),
    },
    {
      label: 'a directory',
      code: 'keyring_unreadable',
      edit: (files) => {
        const dir = join(files.dir, 'keyring-dir');
        mkdirSync(dir);
        return { keyringFile: dir };
      },
    },
    { label: 'not JSON', code: 'keyring_invalid', contents: { keyring: `keyring ${doc}` } },
    { label: 'byte order mark', code: 'keyring_invalid', contents: { keyring: `\uFEFF${doc}` } },
    { label: 'not UTF-8', code: 'keyring_invalid', contents: { keyring: notUtf8 } },
    {
      label: 'key_id other than local',
      code: 'keyring_invalid',
      contents: { keyring: JSON.stringify(priorDoc({ keyId: 'prior' })) },
    },
    {
      label: 'no data key',
      code: 'keyring_invalid',
      contents: { keyring: JSON.stringify({ ...priorDoc(), data_keys: [] }) },
    },
    {
      label: 'one byte over the limit',
      code: 'keyring_invalid',
      contents: { keyring: doc.padEnd(KEYRING_LIMIT + 1, ' ') },
    },
    {
      label: 'another master key',
      code: 'unwrap_failed',
      contents: { master: priorMasterText(PRIOR_OTHER_MASTER_LABEL) },
    },
  ];
  const seen: Record<string, string[]> = {};
  for (const item of cases) {
    const files = fresh('keyring', item.contents ?? {});
    const prior = { ...priorLocal(files), ...(item.edit?.(files) ?? {}) };
    seen[item.label] = await rejectionProblems(
      openPriorIdentityFieldCrypto('test', prior, fieldLocal(files)),
      item.code,
    );
  }
  for (const [label, keyring] of [
    ['exactly at the limit', doc.padEnd(KEYRING_LIMIT, ' ')],
    ['with an unused property', JSON.stringify({ ...priorDoc(), note: 'X' })],
  ] as const) {
    const files = fresh('keyring-ok', { keyring });
    const opened = await settle(
      openPriorIdentityFieldCrypto('test', priorLocal(files), fieldLocal(files)),
    );
    seen[label] =
      'value' in opened ? priorCipherProblems(opened.value, [1, 2], 2) : [explain(opened.error)];
  }
  expect(seen).toEqual(Object.fromEntries(Object.keys(seen).map((key) => [key, []])));
  expect(Object.keys(seen)).toHaveLength(cases.length + 2);
});

it('[AC-B1-27e#21][BR-ID-25] 旧身份 keyring 与主密钥环有任一数据密钥相同（任意版本）时以 shares_main_data_key 拒绝；主密钥可共用，盲索引键不比对，没有主密钥环时不比对', async () => {
  const shared: Record<string, Parameters<typeof writePriorFiles>[1]> = {
    'a copy of the main files': { master: masterText(), keyring: JSON.stringify(keyringDoc()) },
    'prior version 1 is main version 1': {
      keyring: JSON.stringify(priorDoc({ keyLabels: { 1: 1 } })),
    },
    'prior current version is main version 1': {
      keyring: JSON.stringify(priorDoc({ keyLabels: { 2: 1 } })),
    },
    'prior version 3 is main version 2': {
      keyring: JSON.stringify(priorDoc({ versions: [1, 2, 3], keyLabels: { 3: 2 } })),
    },
  };
  const seen: Record<string, string[]> = {};
  for (const appEnv of ['test', 'staging'] as const) {
    for (const [label, contents] of Object.entries(shared)) {
      const files = fresh('shares', contents);
      seen[`${appEnv}: ${label}`] = await rejectionProblems(
        openPriorIdentityFieldCrypto(appEnv, priorLocal(files), fieldLocal(files)),
        'shares_main_data_key',
      );
    }
  }
  const allowed: Record<string, Parameters<typeof writePriorFiles>[1]> = {
    'the same master key': {
      master: masterText(),
      keyring: JSON.stringify(priorDoc({ masterLabel: MASTER_LABEL })),
    },
    'the same blind-index key': {
      keyring: JSON.stringify(priorDoc({ blindLabel: BLIND_KEY_LABEL })),
    },
  };
  for (const [label, contents] of Object.entries(allowed)) {
    const files = fresh('shares-allowed', contents);
    const opened = await settle(
      openPriorIdentityFieldCrypto('test', priorLocal(files), fieldLocal(files)),
    );
    seen[`allowed: ${label}`] =
      'value' in opened ? ['opened'] : [`rejected: ${explain(opened.error)}`];
  }
  const copy = fresh('shares-no-main', shared['a copy of the main files'] ?? {});
  const withoutMain = await settle(openPriorIdentityFieldCrypto('test', priorLocal(copy), null));
  seen['allowed: a copy without a main keyring'] =
    'value' in withoutMain ? ['opened'] : [`rejected: ${explain(withoutMain.error)}`];
  expect(seen).toEqual({
    'test: a copy of the main files': [],
    'test: prior version 1 is main version 1': [],
    'test: prior current version is main version 1': [],
    'test: prior version 3 is main version 2': [],
    'staging: a copy of the main files': [],
    'staging: prior version 1 is main version 1': [],
    'staging: prior current version is main version 1': [],
    'staging: prior version 3 is main version 2': [],
    'allowed: the same master key': ['opened'],
    'allowed: the same blind-index key': ['opened'],
    'allowed: a copy without a main keyring': ['opened'],
  });
});

it('[AC-B1-27e#22][BR-ID-25] 比对时主密钥环读不了或解不开以 main_keyring_unavailable 拒绝；旧身份自己的错误在前', async () => {
  const cases: Record<
    string,
    {
      readonly code: PriorIdentityKeyringErrorCode;
      readonly contents?: Parameters<typeof writePriorFiles>[1];
      readonly main: (files: PriorFiles) => ReturnType<typeof fieldLocal>;
    }
  > = {
    'main keyring file missing': {
      code: 'main_keyring_unavailable',
      main: (files) => ({ ...fieldLocal(files), keyringFile: join(files.dir, 'none.json') }),
    },
    'main master key file is /dev/null': {
      code: 'main_keyring_unavailable',
      main: (files) => ({ ...fieldLocal(files), masterKeyFile: '/dev/null' }),
    },
    'main keyring under another master key': {
      code: 'main_keyring_unavailable',
      contents: { fieldMaster: masterText(OTHER_MASTER_LABEL) },
      main: fieldLocal,
    },
    'main keyring not JSON': {
      code: 'main_keyring_unavailable',
      contents: { fieldKeyring: 'not a keyring' },
      main: fieldLocal,
    },
    'prior unwrap fails first': {
      code: 'unwrap_failed',
      contents: { master: priorMasterText(PRIOR_OTHER_MASTER_LABEL) },
      main: (files) => ({ ...fieldLocal(files), keyringFile: join(files.dir, 'none.json') }),
    },
  };
  const seen: Record<string, string[]> = {};
  for (const [label, item] of Object.entries(cases)) {
    const files = fresh('main-unavailable', item.contents ?? {});
    seen[label] = await rejectionProblems(
      openPriorIdentityFieldCrypto('test', priorLocal(files), item.main(files)),
      item.code,
    );
  }
  expect(seen).toEqual(Object.fromEntries(Object.keys(cases).map((key) => [key, []])));
});

it('[AC-B1-27e#23][BR-ID-25] 打开之后不再读文件：删掉或改写两套密钥环的文件，返回的 FieldCrypto 照常可用', async () => {
  const files = fresh('after-open');
  const opened = await settle(
    openPriorIdentityFieldCrypto('test', priorLocal(files), fieldLocal(files)),
  );
  rmSync(files.masterFile);
  writeFileSync(
    files.keyringFile,
    JSON.stringify(priorDoc({ masterLabel: PRIOR_OTHER_MASTER_LABEL })),
  );
  rmSync(files.fieldMasterFile);
  rmSync(files.fieldKeyringFile);
  expect(
    'value' in opened ? priorCipherProblems(opened.value, [1, 2], 2) : [explain(opened.error)],
  ).toEqual([]);
});

// ---- nothing printed by the opener ------------------------------------------------------------

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));

function runChild(request: PriorChildRequest): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly reply: PriorChildReply | string;
} {
  const run = spawnSync(process.execPath, [CHILD], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env['PATH'] ?? '' },
  });
  let reply: PriorChildReply | string;
  try {
    reply = JSON.parse(run.stdout) as PriorChildReply;
  } catch {
    reply = 'stdout is not one JSON reply';
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, reply };
}

it('[AC-B1-27e#24][BR-ID-25][BR-ID-33] openPriorIdentityFieldCrypto 在独立进程里成功、失败都不打印任何东西：stdout 正好是回复、stderr 为空，文件里的身份证号、姓名与密钥标记哪里都找不到', () => {
  const marker = testKey(98).toString('hex');
  const planted = { id_no: SAMPLES.idNo, name: SAMPLES.name, marker };
  const files = {
    ok: fresh('child-ok', { keyring: JSON.stringify({ ...priorDoc(), ...planted }) }),
    notJson: fresh('child-not-json', {
      keyring: `id=${SAMPLES.idNo} name=${SAMPLES.name} key=${marker}`,
    }),
    masterIdNo: fresh('child-master', { master: `${SAMPLES.idNo}${SAMPLES.idNo}\n` }),
    otherMaster: fresh('child-other', { master: `${marker}\n` }),
    copy: fresh('child-copy', { master: masterText(), keyring: JSON.stringify(keyringDoc()) }),
  };
  const request: PriorChildRequest = {
    open: [
      { appEnv: 'test', prior: priorLocal(files.ok), keyring: fieldLocal(files.ok) },
      { appEnv: 'local', prior: null, keyring: null },
      { appEnv: 'test', prior: priorLocal(files.notJson), keyring: fieldLocal(files.notJson) },
      { appEnv: 'test', prior: priorLocal(files.masterIdNo), keyring: null },
      { appEnv: 'test', prior: priorLocal(files.otherMaster), keyring: null },
      { appEnv: 'test', prior: priorLocal(files.copy), keyring: fieldLocal(files.copy) },
      {
        appEnv: 'test',
        prior: priorLocal(files.ok),
        keyring: { ...fieldLocal(files.ok), keyringFile: join(files.ok.dir, 'none.json') },
      },
      { appEnv: 'prod', prior: priorLocal(files.ok), keyring: null },
      {
        appEnv: 'staging',
        prior: { provider: 'kms', keyringFile: files.ok.keyringFile },
        keyring: null,
      },
      { appEnv: 'staging', prior: null, keyring: fieldLocal(files.ok) },
    ],
    plaintexts: [SAMPLES.idNo, SAMPLES.name, marker],
    messages: PRIOR_MESSAGES,
  };
  const run = runChild(request);
  const refused = (code: PriorIdentityKeyringErrorCode) => ({ code, exact: true });
  expect(run.reply).toEqual({
    open: [
      { opened: true, currentKeyVersion: 2, roundTrips: true },
      { opened: true, currentKeyVersion: 1, roundTrips: true },
      refused('keyring_invalid'),
      refused('master_key_invalid'),
      refused('unwrap_failed'),
      refused('shares_main_data_key'),
      refused('main_keyring_unavailable'),
      refused('local_in_cloud'),
      refused('kms_unavailable'),
      refused('not_configured'),
    ],
  });
  expect({
    status: run.status,
    stderr: run.stderr,
    exact: run.stdout === JSON.stringify(run.reply),
  }).toEqual({ status: 0, stderr: '', exact: true });
  const secrets = {
    ...priorSecretsOf(files.ok),
    'id number': SAMPLES.idNo,
    name: SAMPLES.name,
    'key marker': marker,
    'key marker bytes': testKey(98),
  };
  expect(leaksIn(`${run.stdout}\n${run.stderr}`, secrets)).toEqual([]);
});
