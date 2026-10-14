import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import {
  CLIENT_ID,
  OTHER_SECRET,
  SECRET,
  clock,
  configured,
  context,
  endpoints,
  environment,
  observePdd,
  removeDirectory,
  startUnion,
  startupFailure,
  temporaryDirectory,
  visible,
} from './kit.ts';

// Give spies a mutable module surface; native ESM namespace properties are not configurable.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real };
});

let directory: string;
beforeEach(async () => {
  directory = await temporaryDirectory();
  // Even a broken implementation must not contact a real network from these tests.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('FAKE_NETWORK_MUST_BE_STUBBED')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await removeDirectory(directory);
});

it.each(['local', 'test', 'prod'] as const)(
  '[AC-B1-04t-STARTUP#1] %s 的 pdd/live 在模块工厂拒绝（prod 等待 KMS），不构造适配器或联网',
  async (appEnv) => {
    const observed = observePdd();
    const config = loadConfig(environment(appEnv));
    const error = await startupFailure(() => startUnion(config, endpoints()));
    expect(error.message.length).toBeGreaterThan(0);
    expect(observed.constructor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(['local', 'test', 'prod'] as const)(
  '[AC-B1-04t-STARTUP#8] %s 即使直接注入 staging 配置与可读文件，也不得绕过 live 禁令',
  async (appEnv) => {
    const file = join(directory, 'FAKE_BYPASS_SECRET.txt');
    await fs.writeFile(file, SECRET, 'utf8');
    const observed = observePdd();
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const config = { ...configured(file), appEnv };
    await startupFailure(() => startUnion(config, endpoints()));
    expect(observed.constructor).not.toHaveBeenCalled();
    expect(readFile.mock.calls.filter(([path]) => String(path) === file)).toHaveLength(0);
    expect(open.mock.calls.filter(([path]) => String(path) === file)).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04t-STARTUP#2] staging 的 pdd/live 缺凭据在启动时失败，不延迟到第一次请求', async () => {
  const observed = observePdd();
  await startupFailure(() => startUnion(loadConfig(environment('staging')), endpoints()));
  expect(observed.constructor).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['', '\n', '\r\n', 'missing', 'directory'])(
  '[AC-B1-04t-STARTUP#3] 文件为空/仅换行/不存在/无法读取时启动失败且错误不含路径或内容：%j',
  async (content) => {
    const observed = observePdd();
    const errors: Error[] = [];
    const logs: string[] = [];
    for (const label of ['FAKE_PATH_A', 'FAKE_PATH_B']) {
      const file = join(directory, `${label}-${CLIENT_ID}.txt`);
      if (content === 'directory') await fs.mkdir(file);
      else if (content !== 'missing') await fs.writeFile(file, content, 'utf8');
      const error = await startupFailure(() => startUnion(configured(file), endpoints(), logs));
      expect(visible(error)).not.toContain(file);
      expect(visible(error)).not.toContain(directory);
      expect(visible(error)).not.toContain(label);
      expect(visible(error)).not.toContain(CLIENT_ID);
      expect(error.cause).toBeUndefined();
      errors.push(error);
    }
    expect(errors[0]!.message).toBe(errors[1]!.message);
    expect(logs.join('\n')).not.toContain(directory);
    expect(logs.join('\n')).not.toContain(CLIENT_ID);
    expect(observed.constructor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04t-STARTUP#4] EACCES 原始异常含路径和假 secret 也不能透传到启动错误或日志', async () => {
  const file = join(directory, 'FAKE_PERMISSION_DENIED.txt');
  const config = configured(file);
  const originalOpen = fs.open;
  const originalReadFile = fs.readFile;
  const unsafe = Object.assign(new Error(`EACCES ${file} ${SECRET}`), {
    code: 'EACCES',
    path: file,
  });
  // Deterministic even when the verification container runs as root; chmod(000) is not reliable.
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === file) throw unsafe;
    return originalOpen(...args);
  });
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (String(args[0]) === file) throw unsafe;
    return originalReadFile(...args);
  });
  const logs: string[] = [];
  const error = await startupFailure(() => startUnion(config, endpoints(), logs));
  expect(error).not.toBe(unsafe);
  expect(error.cause).toBeUndefined();
  for (const marker of [file, directory, SECRET]) {
    expect(visible(error)).not.toContain(marker);
    expect(logs.join('\n')).not.toContain(marker);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['', '\n', '\r\n'])(
  '[AC-B1-04t-STARTUP#5] staging 在启动时读一次并去末尾换行 %j，删除文件后仍用原凭据且不泄漏',
  async (suffix) => {
    const file = join(directory, 'FAKE_SECRET_FILE.txt');
    await fs.writeFile(file, `${SECRET}${suffix}`, 'utf8');
    const observed = observePdd();
    const readFile = vi.spyOn(fs, 'readFile');
    const open = vi.spyOn(fs, 'open');
    const config = configured(file);
    expect(readFile.mock.calls.filter(([path]) => String(path) === file)).toHaveLength(0);
    expect(open.mock.calls.filter(([path]) => String(path) === file)).toHaveLength(0);
    const logs: string[] = [];
    // The module must use the passed config, not the ambient process environment.
    vi.stubEnv('PDD_CLIENT_ID', 'FAKE_AMBIENT_CLIENT_ID');
    vi.stubEnv('PDD_CLIENT_SECRET_FILE', join(directory, 'FAKE_AMBIENT_MISSING.txt'));
    const registry = await startUnion(config, endpoints(), logs);
    expect(observed.constructor).toHaveBeenCalledTimes(1);
    expect(registry.registrations().find((entry) => entry.platform === 'pdd')?.implemented).toBe(
      true,
    );
    const supplied = observed.constructor.mock.calls[0]![0];
    expect(supplied.clock).toBe(clock);
    expect(supplied.endpoint).toEqual(endpoints().find((entry) => entry.platform === 'pdd'));
    // Change before the FIRST credentials() call: lazy opening must not pass this assertion.
    await fs.writeFile(file, OTHER_SECRET, 'utf8');
    await expect(supplied.credentials()).resolves.toEqual({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
    });
    await fs.rm(file);
    await expect(supplied.credentials()).resolves.toEqual({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
    });
    expect(registry.get('pdd')).toBe(observed.constructor.mock.results[0]!.value);
    await registry.get('pdd').searchItems({ keyword: 'synthetic' }, context);
    expect(observed.search).toHaveBeenCalledExactlyOnceWith({ keyword: 'synthetic' }, context);
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(JSON.stringify(registry)).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain(file);
    // Either readFile or open + FileHandle.read is valid; both read the file only at startup.
    expect(
      readFile.mock.calls.filter(([path]) => String(path) === file).length +
        open.mock.calls.filter(([path]) => String(path) === file).length,
    ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04t-STARTUP#6] 工厂向 B1-04g 注入现有 HTTPS 传输，禁止降级与跳转', async () => {
  const file = join(directory, 'FAKE_SECRET_FILE.txt');
  await fs.writeFile(file, SECRET, 'utf8');
  const observed = observePdd();
  await startUnion(configured(file), endpoints());
  expect(observed.constructor).toHaveBeenCalledTimes(1);
  const transport = observed.constructor.mock.calls[0]![0].transport;
  const network = vi
    .fn()
    .mockResolvedValue(new Response('synthetic transport body', { status: 200 }));
  vi.stubGlobal('fetch', network);
  const signal = new AbortController().signal;
  const request = {
    platform: 'pdd' as const,
    url: 'https://pdd.invalid/router',
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: 'synthetic transport body',
    signal,
  };
  await expect(transport(request)).resolves.toMatchObject({
    status: 200,
    body: 'synthetic transport body',
  });
  expect(network).toHaveBeenCalledExactlyOnceWith(
    request.url,
    expect.objectContaining({
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal,
      redirect: 'error',
    }),
  );
  await expect(transport({ ...request, url: 'http://pdd.invalid/router' })).rejects.toMatchObject({
    code: 'invalid_endpoint',
  });
  expect(network).toHaveBeenCalledTimes(1);
});

it.each(['replay', 'demo'] as const)(
  '[AC-B1-04t-STARTUP#7] staging %s 不读取或装配真实凭据，同一配置切 live 才装配',
  async (mode) => {
    const file = join(directory, 'FAKE_SECRET_FILE.txt');
    const observed = observePdd();
    const config = configured(file);
    // No file exists yet: replay/demo must not even attempt to open it.
    const dormant = await startUnion(config, endpoints(mode));
    expect(observed.constructor).not.toHaveBeenCalled();
    if (mode === 'replay') {
      await expect(
        dormant.get('pdd').searchItems({ keyword: '演示' }, context),
      ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
    } else {
      const page = await dormant.get('pdd').searchItems({ keyword: '演示' }, context);
      expect(page.items.length).toBeGreaterThan(0);
    }
    await fs.writeFile(file, SECRET, 'utf8');
    const live = await startUnion(config, endpoints());
    expect(live.registrations().find((entry) => entry.platform === 'pdd')?.implemented).toBe(true);
    expect(observed.constructor).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  },
);
