// B1-01zd §9 / BR-ID-33: temporary synthetic keys only; run in the orchestrator's container.
// Negative cases first create a real keyring, so a stub that always throws cannot pass them.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { initLocalKeyring } from '../../../../apps/api/scripts/keyring-init.ts';
import { openConfiguredFieldCrypto } from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import type { WrappedKeyring } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { referenceBlindIndex, referenceDecrypt, referenceUnwrap, SAMPLES, testKey } from './kit.ts';
import { makeDir, removeDir, settle } from './wiring-kit.ts';

const script = fileURLToPath(
  new URL('../../../../apps/api/scripts/keyring-init.ts', import.meta.url),
);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function fixture(newline = true) {
  const dir = makeDir('b1-01zd-init');
  dirs.push(dir);
  const master = testKey(93);
  const masterFile = join(dir, '临时主密钥 文件.hex');
  const outputFile = join(dir, '新密钥环 文件.json');
  const masterText = master.toString('hex') + (newline ? '\n' : '');
  writeFileSync(masterFile, masterText, { mode: 0o600 });
  return { dir, master, masterFile, masterText, outputFile };
}

type Fixture = ReturnType<typeof fixture>;

/** Check the actual file using independent AES-GCM/HMAC references, not only a round trip. */
async function inspectGenerated(files: Fixture): Promise<readonly [Buffer, Buffer, Buffer]> {
  expect(existsSync(files.outputFile), 'the command must create the output file').toBe(true);
  expect(statSync(files.outputFile).isFile()).toBe(true);
  expect(statSync(files.outputFile).mode & 0o777).toBe(0o600);
  expect(readFileSync(files.masterFile, 'utf8') === files.masterText).toBe(true);
  const text = readFileSync(files.outputFile, 'utf8');
  const doc = JSON.parse(text) as WrappedKeyring;
  expect(doc.key_id).toBe('local');
  expect(doc.current_version).toBe(1);
  expect(doc.data_keys).toHaveLength(1);
  expect(doc.data_keys[0]?.version).toBe(1);
  expect(typeof doc.data_keys[0]?.wrapped).toBe('string');
  expect(typeof doc.blind_index_key).toBe('string');
  const data = referenceUnwrap(files.master, 'local', doc.data_keys[0]?.wrapped ?? '');
  const blind = referenceUnwrap(files.master, 'local', doc.blind_index_key);
  expect(data.byteLength).toBe(32);
  expect(blind.byteLength).toBe(32);
  expect(data.equals(blind)).toBe(false);
  expect(data.equals(files.master)).toBe(false);
  expect(blind.equals(files.master)).toBe(false);
  const crypto = await openConfiguredFieldCrypto('test', {
    provider: 'local',
    masterKeyFile: files.masterFile,
    keyringFile: files.outputFile,
  });
  const ciphertext = crypto.encrypt(SAMPLES.phone, 'users.phone');
  expect(referenceDecrypt(data, ciphertext, 'users.phone') === SAMPLES.phone).toBe(true);
  expect(crypto.decrypt(ciphertext, 'users.phone') === SAMPLES.phone).toBe(true);
  expect(
    crypto.blindIndex(SAMPLES.phone, 'users.phone') ===
      referenceBlindIndex(blind, SAMPLES.phone, 'users.phone'),
  ).toBe(true);
  assertNoKeyMaterial(text, [files.master, data, blind]);
  return [files.master, data, blind];
}

function assertNoKeyMaterial(output: string, keys: readonly Buffer[]): void {
  for (const key of keys) {
    for (const encoding of ['hex', 'base64', 'base64url'] as const) {
      // Compare booleans so a failure report cannot echo the very key being searched for.
      expect(output.includes(key.toString(encoding)), `must not expose ${encoding} key bytes`).toBe(
        false,
      );
    }
    expect(
      output.includes(key.toString('hex').toUpperCase()),
      'must not expose uppercase hex',
    ).toBe(false);
  }
}

function cli(args: readonly string[]) {
  // Set umask only in the child, before executing the real CLI entry. A default-mode
  // write would produce 0644 here, so an inherited restrictive umask cannot hide it.
  const run = spawnSync(
    process.execPath,
    ['--import', 'data:text/javascript,process.umask(0o022)', script, ...args],
    {
      env: { APP_ENV: 'test', NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  // Never echo child output into a test failure: it could hold key material.
  expect(run.error === undefined, 'child process must run without a spawn/timeout error').toBe(
    true,
  );
  expect(run.signal).toBeNull();
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

it.each([false, true])(
  '[AC-B1-01zd#1][BR-ID-33] 本地主密钥生成可打开的信封密钥环，权限 600（末尾 LF=%s）',
  async (newline) => {
    const files = fixture(newline);
    await initLocalKeyring(files.masterFile, files.outputFile);
    await inspectGenerated(files);
  },
);

it('[AC-B1-01zd#2][BR-ID-33] 已存在的密钥环及其他文件均拒绝覆盖，字节与权限不变', async () => {
  const files = fixture();
  await initLocalKeyring(files.masterFile, files.outputFile);
  await inspectGenerated(files);
  const otherFile = join(files.dir, 'already-exists.txt');
  writeFileSync(otherFile, 'existing operator content', { mode: 0o640 });
  for (const output of [files.outputFile, otherFile, files.masterFile]) {
    const before = readFileSync(output);
    const mode = statSync(output).mode;
    const outcome = await settle(initLocalKeyring(files.masterFile, output));
    expect('error' in outcome, 'existing output must reject').toBe(true);
    expect(readFileSync(output).equals(before), 'existing bytes must stay unchanged').toBe(true);
    expect(statSync(output).mode).toBe(mode);
  }
});

it('[AC-B1-01zd#3][BR-ID-33] 主密钥格式沿用启动校验，非法或不可读时不产生密钥环', async () => {
  const files = fixture();
  await initLocalKeyring(files.masterFile, files.outputFile);
  await inspectGenerated(files);
  const hex = files.master.toString('hex');
  const badMaster = join(files.dir, 'invalid-master.hex');
  const missingOutput = join(files.dir, 'must-not-exist.json');
  for (const text of ['', hex.toUpperCase(), `${hex}\r\n`, `${hex}\n\n`, `${hex} `, hex.slice(2)]) {
    writeFileSync(badMaster, text, { mode: 0o600 });
    const outcome = await settle(initLocalKeyring(badMaster, missingOutput));
    expect('error' in outcome).toBe(true);
    expect(existsSync(missingOutput)).toBe(false);
  }
  for (const path of [join(files.dir, 'missing.hex'), files.dir]) {
    const outcome = await settle(initLocalKeyring(path, missingOutput));
    expect('error' in outcome).toBe(true);
    expect(existsSync(missingOutput)).toBe(false);
  }
});

it('[AC-B1-01zd#4][BR-ID-33] 子进程 umask=022 时直接运行命令生成权限 600 的可打开密钥环，stdout/stderr 无主密钥、数据密钥和盲索引密钥', async () => {
  const files = fixture();
  const run = cli([files.masterFile, files.outputFile]);
  expect(run.status).toBe(0);
  const keys = await inspectGenerated(files);
  assertNoKeyMaterial(run.output, keys);
});

it('[AC-B1-01zd#17][BR-ID-33] 同一主密钥连续生成两份密钥环，数据密钥与盲索引密钥均重新随机生成', async () => {
  const first = fixture();
  const second = { ...first, outputFile: join(first.dir, '第二份密钥环.json') };
  await initLocalKeyring(first.masterFile, first.outputFile);
  const [, firstData, firstBlind] = await inspectGenerated(first);
  await initLocalKeyring(second.masterFile, second.outputFile);
  const [, secondData, secondBlind] = await inspectGenerated(second);
  // Compare unwrapped key bytes, not wrapped ciphertext (which has a random nonce).
  expect(firstData.equals(secondData), 'data key must be fresh for each keyring').toBe(false);
  expect(firstBlind.equals(secondBlind), 'blind-index key must be fresh for each keyring').toBe(
    false,
  );
});

it('[AC-B1-01zd#5][BR-ID-33] 命令重复执行失败且不覆盖原文件，错误输出不泄露密钥', async () => {
  const files = fixture();
  const created = cli([files.masterFile, files.outputFile]);
  expect(created.status).toBe(0);
  const keys = await inspectGenerated(files);
  const before = readFileSync(files.outputFile);
  const refused = cli([files.masterFile, files.outputFile]);
  expect(refused.status).toBe(1);
  expect(readFileSync(files.outputFile).equals(before)).toBe(true);
  expect(statSync(files.outputFile).mode & 0o777).toBe(0o600);
  assertNoKeyMaterial(created.output + refused.output, keys);
});

it('[AC-B1-01zd#6][BR-ID-33] 命令拒绝缺少参数和损坏的主密钥，错误输出无密钥内容', async () => {
  const files = fixture();
  const created = cli([files.masterFile, files.outputFile]);
  expect(created.status).toBe(0);
  const keys = await inspectGenerated(files);
  const output = join(files.dir, 'must-not-exist.json');
  writeFileSync(files.masterFile, `${files.masterText}invalid`, { mode: 0o600 });
  for (const args of [[], [files.masterFile], [files.masterFile, output]]) {
    const refused = cli(args);
    expect(refused.status).toBe(1);
    expect(existsSync(output)).toBe(false);
    assertNoKeyMaterial(created.output + refused.output, keys);
  }
});
