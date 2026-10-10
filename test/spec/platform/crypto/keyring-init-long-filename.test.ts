// B1-01zx: legal 250-byte output names must not make the temporary name exceed NAME_MAX.
// Synthetic keys and real files under .tmp only; execute in the orchestrator's container.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { openConfiguredFieldCrypto } from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import { SAMPLES, testKey } from './kit.ts';
import { makeDir, removeDir } from './wiring-kit.ts';

const script = fileURLToPath(
  new URL('../../../../apps/api/scripts/keyring-init.ts', import.meta.url),
);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function cli(masterFile: string, outputFile: string) {
  // A permissive child umask ensures that a default 0644 file cannot pass the mode assertion.
  const run = spawnSync(
    process.execPath,
    ['--import', 'data:text/javascript,process.umask(0o022)', script, masterFile, outputFile],
    {
      env: { APP_ENV: 'test', NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 64 * 1024,
    },
  );
  // Do not include child output in diagnostics: it could contain generated key material.
  expect(run.error === undefined, 'CLI must start and finish without a spawn/timeout error').toBe(
    true,
  );
  expect(run.signal).toBeNull();
  return run.status;
}

it.each([
  { ac: 1, label: 'ASCII', filename: `${'k'.repeat(245)}.json` },
  { ac: 2, label: '中文 UTF-8', filename: `${'密'.repeat(81)}aa.json` },
])(
  '[AC-B1-01zx#$ac] $label 输出文件名为 250 字节时创建成功、权限 0600、无临时残留且重跑拒绝覆盖',
  async ({ filename }) => {
    expect(Buffer.byteLength(filename, 'utf8')).toBe(250);
    const dir = makeDir('b1-01zx-long');
    dirs.push(dir);
    const masterFile = join(dir, 'synthetic-master.hex');
    const outputFile = join(dir, filename);
    writeFileSync(masterFile, `${testKey(99).toString('hex')}\n`, { mode: 0o600 });
    const expectedFiles = [basename(masterFile), filename].sort();

    // On the old implementation the process exits 1 (ENAMETOOLONG), so this is an assertion red.
    // Creating first also prevents the refusal check from passing merely because all calls fail.
    expect(cli(masterFile, outputFile), 'a legal 250-byte output name must be accepted').toBe(0);
    const before = readFileSync(outputFile);
    const stat = statSync(outputFile, { bigint: true });
    expect(stat.isFile()).toBe(true);
    expect(Number(stat.mode & 0o777n)).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(expectedFiles);

    const crypto = await openConfiguredFieldCrypto('test', {
      provider: 'local',
      masterKeyFile: masterFile,
      keyringFile: outputFile,
    });
    const ciphertext = crypto.encrypt(SAMPLES.phone, 'users.phone');
    expect(crypto.decrypt(ciphertext, 'users.phone') === SAMPLES.phone).toBe(true);

    expect(cli(masterFile, outputFile), 'an existing long output name must refuse overwrite').toBe(
      1,
    );
    expect(readFileSync(outputFile).equals(before), 'existing bytes must remain unchanged').toBe(
      true,
    );
    const after = statSync(outputFile, { bigint: true });
    expect(after.ino).toBe(stat.ino);
    expect(after.mtimeNs).toBe(stat.mtimeNs);
    expect(after.mode).toBe(stat.mode);
    expect(readdirSync(dir).sort()).toEqual(expectedFiles);
  },
  60_000,
);
