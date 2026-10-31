import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readDataokeConfig } from './dataoke.ts';
import { DataokeStartupError, openDataokeCredentials } from './dataoke-startup.ts';

const KEY = 'FAKE_UNIT_DATAOKE_APP_KEY';
const PATH = '/FAKE_UNIT_DATAOKE_PATH/secret.txt';
const root = fileURLToPath(new URL('../../../../../../', import.meta.url));

it('[AC-B1-04e-UNIT#1] staging 两个变量同设才得到配置，只设一个报变量名不带值', () => {
  expect(readDataokeConfig('staging', {})).toEqual({ dataoke: null, problems: [] });
  expect(
    readDataokeConfig('staging', { DATAOKE_APP_KEY: KEY, DATAOKE_APP_SECRET_FILE: PATH }),
  ).toEqual({ dataoke: { appKey: KEY, secretFile: PATH }, problems: [] });
  for (const env of [{ DATAOKE_APP_KEY: KEY }, { DATAOKE_APP_SECRET_FILE: PATH }]) {
    const one = readDataokeConfig('staging', env);
    expect(one.dataoke).toBeNull();
    expect(one.problems.join('\n')).toContain('DATAOKE_APP_KEY');
    expect(one.problems.join('\n')).toContain('DATAOKE_APP_SECRET_FILE');
    expect(one.problems.join('\n')).not.toContain(KEY);
    expect(one.problems.join('\n')).not.toContain(PATH);
  }
});

it('[AC-B1-04e-UNIT#2] prod 设密钥文件即报错；local / test 交给 startupViolations', () => {
  expect(readDataokeConfig('prod', { DATAOKE_APP_SECRET_FILE: PATH }).problems).toHaveLength(1);
  expect(readDataokeConfig('prod', { DATAOKE_APP_KEY: KEY })).toEqual({
    dataoke: null,
    problems: [],
  });
  expect(readDataokeConfig('local', { DATAOKE_APP_KEY: KEY })).toEqual({
    dataoke: null,
    problems: [],
  });
});

async function code(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DataokeStartupError) {
      expect(error.cause).toBeUndefined();
      return error.code;
    }
    throw error;
  }
  return 'resolved';
}

it('[AC-B1-04e-UNIT#3] 按环境拒绝（staging 两个都没设也拒绝），staging 读一次文件、去掉一个末尾换行', async () => {
  const dataoke = { appKey: KEY, secretFile: PATH };
  expect(await code(() => openDataokeCredentials('local', dataoke))).toBe('live_in_local');
  expect(await code(() => openDataokeCredentials('test', dataoke))).toBe('live_in_local');
  expect(await code(() => openDataokeCredentials('prod', dataoke))).toBe('kms_unavailable');
  expect(await code(() => openDataokeCredentials('prod', null))).toBe('kms_unavailable');
  expect(await code(() => openDataokeCredentials('staging', null))).toBe('credentials_missing');
  expect(await code(() => openDataokeCredentials('staging', undefined))).toBe(
    'credentials_missing',
  );
  expect(await code(() => openDataokeCredentials('staging', dataoke))).toBe('secret_unreadable');

  const parent = join(root, '.tmp/dataoke-startup-unit');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  try {
    const file = join(directory, 'secret.txt');
    await writeFile(file, 'FAKE_UNIT_SECRET\n\n', 'utf8');
    const credentials = await openDataokeCredentials('staging', { appKey: KEY, secretFile: file });
    await rm(file);
    await expect(credentials()).resolves.toEqual({
      appKey: KEY,
      appSecret: 'FAKE_UNIT_SECRET\n',
    });
    await writeFile(file, '\r\n', 'utf8');
    expect(
      await code(() => openDataokeCredentials('staging', { appKey: KEY, secretFile: file })),
    ).toBe('secret_invalid');
    await writeFile(file, 'x'.repeat(4097), 'utf8');
    expect(
      await code(() => openDataokeCredentials('staging', { appKey: KEY, secretFile: file })),
    ).toBe('secret_invalid');
    expect(
      await code(() => openDataokeCredentials('staging', { appKey: KEY, secretFile: directory })),
    ).toBe('secret_unreadable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
