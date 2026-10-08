// B1-01zi / BR-ID-33. Only synthetic keys, real files below .tmp, container execution only.
// Intercept FileHandle I/O to observe the exact write/fsync boundaries without timing races.
// No SIGKILL is sent: the final name must be absent even after a real partial write.
import { spawnSync } from 'node:child_process';
import {
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { initLocalKeyring, main } from '../../../../apps/api/scripts/keyring-init.ts';
import { openConfiguredFieldCrypto } from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import type { WrappedKeyring } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { referenceUnwrap, SAMPLES, testKey } from './kit.ts';
import { makeDir, removeDir, settle } from './wiring-kit.ts';

type Boundary = 'before-write' | 'after-write' | 'before-sync' | 'after-sync';
type Observe = (boundary: Boundary, file: FileHandle, path: string) => Promise<void>;
const hooks = vi.hoisted(() => ({
  observe: undefined as Observe | undefined,
  opens: [] as { path: string; exclusive: boolean }[],
  payloads: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof real.open = async (path, flags, mode) => {
    const file = await real.open(path, flags, mode);
    const name = path instanceof URL ? fileURLToPath(path) : path.toString();
    hooks.opens.push({
      path: name,
      exclusive:
        typeof flags === 'string' ? flags.includes('x') : ((flags ?? 0) & constants.O_EXCL) !== 0,
    });
    const write = file.writeFile.bind(file);
    const sync = file.sync.bind(file);
    vi.spyOn(file, 'writeFile').mockImplementation(async (...args) => {
      if (typeof args[0] === 'string') hooks.payloads.push(args[0]);
      await hooks.observe?.('before-write', file, name);
      await write(...args);
      await hooks.observe?.('after-write', file, name);
    });
    vi.spyOn(file, 'sync').mockImplementation(async () => {
      await hooks.observe?.('before-sync', file, name);
      await sync();
      await hooks.observe?.('after-sync', file, name);
    });
    return file;
  };
  return { ...real, open, default: { ...real, open } };
});

const dirs: string[] = [];
afterEach(() => {
  hooks.observe = undefined;
  hooks.opens.length = 0;
  hooks.payloads.length = 0;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function fixture() {
  const dir = makeDir('b1-01zi-atomic');
  dirs.push(dir);
  const master = testKey(97);
  const masterFile = join(dir, '主密钥 文件.hex');
  const outputFile = join(dir, 'keyring.json');
  writeFileSync(masterFile, `${master.toString('hex')}\n`, { mode: 0o600 });
  return { dir, master, masterFile, outputFile };
}

type Files = ReturnType<typeof fixture>;

function captureOutput() {
  const chunks: string[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  }
  return chunks;
}

function assertPrivate(output: string, files: Files, extra: readonly string[] = []) {
  const keys = [files.master];
  const forbidden = [
    files.dir,
    basename(files.dir),
    files.masterFile,
    files.outputFile,
    ...hooks.opens.flatMap(({ path }) => [path, basename(path)]),
    ...extra,
  ];
  for (const payload of hooks.payloads) {
    const doc = JSON.parse(payload) as WrappedKeyring;
    keys.push(referenceUnwrap(files.master, 'local', doc.blind_index_key));
    for (const entry of doc.data_keys) {
      keys.push(referenceUnwrap(files.master, 'local', entry.wrapped));
      forbidden.push(entry.wrapped);
    }
    forbidden.push(payload.trim(), doc.blind_index_key);
  }
  for (const key of keys) {
    forbidden.push(key.toString('hex'), key.toString('hex').toUpperCase());
    forbidden.push(key.toString('base64'), key.toString('base64url'));
  }
  for (const secret of forbidden) {
    // Never echo key bytes, paths or file contents in assertion diagnostics.
    expect(output.includes(secret), 'output must not disclose sensitive material').toBe(false);
  }
}

function observeWrites(files: Files) {
  const snapshots: { boundary: Boundary; hidden: boolean; sibling: boolean; mode: number }[] = [];
  const synced: Buffer[] = [];
  hooks.observe = async (boundary, file, path) => {
    if (!(await file.stat()).isFile()) return; // A directory fsync is allowed as well.
    snapshots.push({
      boundary,
      hidden: !existsSync(files.outputFile),
      sibling: dirname(path) === files.dir && path !== files.outputFile,
      mode: statSync(path).mode & 0o777,
    });
    if (boundary === 'after-sync') synced.push(readFileSync(path));
  };
  return { snapshots, synced };
}

it('[AC-B1-01zi#1][BR-ID-33] 头注释的主密钥命令首次可用，重跑保留字节和 mtime 并拒绝或明确跳过', () => {
  const files = fixture();
  const source = readFileSync(
    fileURLToPath(new URL('../../../../apps/api/scripts/keyring-init.ts', import.meta.url)),
    'utf8',
  );
  const header = source
    .split('\n')
    .filter((line) => line.startsWith('//'))
    .join('\n');
  const usage = header.split('Usage')[1]?.split('//   node ')[0] ?? '';
  // Keep shell guards on preceding comment lines; substitute only the example's file path.
  const command = usage
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^\/\/\s?/, ''))
    .join('\n');
  expect(command.includes('openssl rand -hex 32')).toBe(true);
  const localCommand = command.replaceAll('/path/to/master.hex', './master.hex');
  const run = () =>
    spawnSync('bash', ['--noprofile', '--norc', '-c', localCommand], {
      cwd: files.dir,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 64 * 1024,
    });
  const first = run();
  expect(first.error === undefined && first.signal === null).toBe(true);
  expect(first.status).toBe(0);
  const masterFile = join(files.dir, 'master.hex');
  const before = readFileSync(masterFile);
  expect(/^[0-9a-f]{64}\n?$/.test(before.toString('utf8'))).toBe(true);
  expect(statSync(masterFile).mode & 0o777).toBe(0o600);
  utimesSync(masterFile, 1_000_000_000, 1_000_000_000);
  const mtime = statSync(masterFile, { bigint: true }).mtimeNs;
  const repeated = run();
  expect(repeated.error === undefined && repeated.signal === null).toBe(true);
  expect(readFileSync(masterFile).equals(before), 'existing master must survive the example').toBe(
    true,
  );
  expect(statSync(masterFile, { bigint: true }).mtimeNs).toBe(mtime);
  expect(repeated.status !== 0 || /skip|跳过|已存在/i.test(repeated.stdout + repeated.stderr)).toBe(
    true,
  );
}, 60_000);

it('[AC-B1-01zi#2][BR-ID-33] 内容写完并 fsync 前最终路径不可见；就位后权限 600、可打开，重跑拒绝且输出脱敏', async () => {
  const files = fixture();
  const chunks = captureOutput();
  const { snapshots, synced } = observeWrites(files);
  expect(await main([files.masterFile, files.outputFile])).toBe(0);
  const before = readFileSync(files.outputFile);
  const stat = statSync(files.outputFile, { bigint: true });
  expect(Number(stat.mode & 0o777n)).toBe(0o600);
  const crypto = await openConfiguredFieldCrypto('test', {
    provider: 'local',
    masterKeyFile: files.masterFile,
    keyringFile: files.outputFile,
  });
  const ciphertext = crypto.encrypt(SAMPLES.phone, 'users.phone');
  expect(crypto.decrypt(ciphertext, 'users.phone') === SAMPLES.phone).toBe(true);
  hooks.observe = undefined;
  expect('error' in (await settle(initLocalKeyring(files.masterFile, files.outputFile)))).toBe(
    true,
  );
  expect(await main([files.masterFile, files.outputFile])).toBe(1);
  expect(readFileSync(files.outputFile).equals(before)).toBe(true);
  expect(statSync(files.outputFile, { bigint: true }).mtimeNs).toBe(stat.mtimeNs);
  expect(readdirSync(files.dir).sort()).toEqual(
    [basename(files.masterFile), 'keyring.json'].sort(),
  );
  assertPrivate(chunks.join(''), files);
  expect(snapshots.map((s) => s.boundary)).toEqual([
    'before-write',
    'after-write',
    'before-sync',
    'after-sync',
  ]);
  expect(synced.length).toBe(1);
  expect(synced[0]?.equals(before)).toBe(true);
  expect(
    snapshots.every((s) => s.hidden),
    'final name must stay absent through fsync',
  ).toBe(true);
  expect(snapshots.every((s) => s.sibling && s.mode === 0o600)).toBe(true);
  expect(
    hooks.opens
      .filter(
        (o) => o.path !== files.masterFile && o.path !== files.outputFile && o.path !== files.dir,
      )
      .every((o) => o.exclusive),
  ).toBe(true);
}, 30_000);

it.each(['partial-write', 'fsync'] as const)(
  '[AC-B1-01zi#3][BR-ID-33] %s 失败时半成品从未出现在最终路径，删除临时文件且不泄密',
  async (failure) => {
    const files = fixture();
    const chunks = captureOutput();
    let injected = false;
    let hiddenAtFailure = false;
    let partialOnDisk = false;
    const message = `${files.outputFile} ${files.master.toString('hex')} synthetic-private-error`;
    hooks.observe = async (boundary, file, path) => {
      if (failure === 'partial-write' && boundary === 'before-write') {
        await file.write('{"incomplete":');
        partialOnDisk = readFileSync(path, 'utf8') === '{"incomplete":';
      } else if (!(failure === 'fsync' && boundary === 'before-sync')) {
        return;
      }
      injected = true;
      hiddenAtFailure = !existsSync(files.outputFile);
      throw Object.assign(new Error(message), { code: failure === 'fsync' ? 'EIO' : 'ENOSPC' });
    };
    expect(await main([files.masterFile, files.outputFile])).toBe(1);
    expect(injected, 'the intended I/O boundary must be reached').toBe(true);
    if (failure === 'partial-write') expect(partialOnDisk).toBe(true);
    expect(existsSync(files.outputFile)).toBe(false);
    expect(readdirSync(files.dir)).toEqual([basename(files.masterFile)]);
    assertPrivate(chunks.join(''), files, [message, 'synthetic-private-error']);
    expect(hiddenAtFailure, 'partial or unsynced data must never occupy the final path').toBe(true);
  },
  30_000,
);

it('[AC-B1-01zi#4][BR-ID-33] fsync 后其他进程抢先占用最终路径时拒绝就位，保留对方文件并清理临时文件', async () => {
  const files = fixture();
  const chunks = captureOutput();
  const competitor = 'another initializer owns this path';
  let raced = false;
  hooks.observe = async (boundary, file) => {
    if (boundary !== 'after-sync' || !(await file.stat()).isFile()) return;
    if (!existsSync(files.outputFile)) {
      writeFileSync(files.outputFile, competitor, { flag: 'wx', mode: 0o600 });
      raced = true;
    }
  };
  const result = await settle(initLocalKeyring(files.masterFile, files.outputFile));
  expect(raced, 'final path must still be free after the temporary file fsync').toBe(true);
  expect('error' in result).toBe(true);
  expect(readFileSync(files.outputFile, 'utf8') === competitor).toBe(true);
  expect(readdirSync(files.dir).sort()).toEqual(
    [basename(files.masterFile), 'keyring.json'].sort(),
  );
  assertPrivate(chunks.join(''), files, [competitor]);
}, 30_000);
