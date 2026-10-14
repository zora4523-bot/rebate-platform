import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readPddConfig } from './pdd.ts';
import { PddStartupError, openPddCredentials } from './pdd-startup.ts';

const ID = 'FAKE_UNIT_CLIENT_ID';
const PATH = '/FAKE_UNIT_PATH/secret.txt';
const root = fileURLToPath(new URL('../../../../../../', import.meta.url));

it('[AC-B1-04t-UNIT#1] staging 两个变量同设才得到配置，只设一个报变量名不带值', () => {
  expect(readPddConfig('staging', {})).toEqual({ pdd: null, problems: [] });
  expect(readPddConfig('staging', { PDD_CLIENT_ID: ID, PDD_CLIENT_SECRET_FILE: PATH })).toEqual({
    pdd: { clientId: ID, secretFile: PATH },
    problems: [],
  });
  const one = readPddConfig('staging', { PDD_CLIENT_ID: ID });
  expect(one.pdd).toBeNull();
  expect(one.problems.join('\n')).toContain('PDD_CLIENT_SECRET_FILE');
  expect(one.problems.join('\n')).not.toContain(ID);
});

it('[AC-B1-04t-UNIT#2] prod 设密钥文件即报错；local / test 交给 startupViolations', () => {
  expect(readPddConfig('prod', { PDD_CLIENT_SECRET_FILE: PATH }).problems).toHaveLength(1);
  expect(readPddConfig('prod', { PDD_CLIENT_ID: ID })).toEqual({ pdd: null, problems: [] });
  expect(readPddConfig('local', { PDD_CLIENT_ID: ID })).toEqual({ pdd: null, problems: [] });
});

async function code(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PddStartupError) {
      expect(error.cause).toBeUndefined();
      return error.code;
    }
    throw error;
  }
  return 'resolved';
}

it('[AC-B1-04t-UNIT#3] 按环境拒绝，staging 读一次文件、去掉一个末尾换行', async () => {
  const pdd = { clientId: ID, secretFile: PATH };
  expect(await code(() => openPddCredentials('local', pdd))).toBe('live_in_local');
  expect(await code(() => openPddCredentials('test', pdd))).toBe('live_in_local');
  expect(await code(() => openPddCredentials('prod', pdd))).toBe('kms_unavailable');
  expect(await code(() => openPddCredentials('staging', null))).toBe('credentials_missing');
  expect(await code(() => openPddCredentials('staging', pdd))).toBe('secret_unreadable');

  const parent = join(root, '.tmp/pdd-startup-unit');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  try {
    const file = join(directory, 'secret.txt');
    await writeFile(file, 'FAKE_UNIT_SECRET\n\n', 'utf8');
    const credentials = await openPddCredentials('staging', { clientId: ID, secretFile: file });
    await rm(file);
    await expect(credentials()).resolves.toEqual({
      clientId: ID,
      clientSecret: 'FAKE_UNIT_SECRET\n',
    });
    await writeFile(file, '\r\n', 'utf8');
    expect(
      await code(() => openPddCredentials('staging', { clientId: ID, secretFile: file })),
    ).toBe('secret_invalid');
    await writeFile(file, 'x'.repeat(4097), 'utf8');
    expect(
      await code(() => openPddCredentials('staging', { clientId: ID, secretFile: file })),
    ).toBe('secret_invalid');
    expect(
      await code(() => openPddCredentials('staging', { clientId: ID, secretFile: directory })),
    ).toBe('secret_unreadable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
