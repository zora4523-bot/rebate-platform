import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { asset, record, string } from './kit.ts';

// B1-01zzm ledger ③ defines these local AC identifiers. Container-only: run a copy of boot.mjs
// whose start counter is relocated into the fixture directory (nothing else changed) in front of
// a stub entry that reports the JWT_* variables it received. Synthetic keys only; no node files.
const KID = 'fixture-kid.7c1e';
const MARKER = 'stub-entry-ran:';
const ENTRY = `const env = process.env;
process.stdout.write('${MARKER}' + JSON.stringify({
  publicPem: env.JWT_PUBLIC_KEY_PEM ?? null,
  keyId: env.JWT_KEY_ID ?? null,
  privatePem: env.JWT_PRIVATE_KEY_PEM ?? null,
}) + '\\n');
`;

interface Pair {
  publicPem: string;
  privatePem: string;
}

interface Boot {
  status: number | null;
  stdout: string;
  stderr: string;
  entry: Record<string, unknown> | null;
}

function keyPair(): Pair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function fixture(run: (directory: string) => void): void {
  const parent = resolve('.tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'stream-jwt-boot-'));
  try {
    const source = asset('infra/staging/boot.mjs');
    expect(source).toContain('/tmp/couli-starts');
    writeFileSync(
      join(directory, 'boot.mjs'),
      source.replaceAll('/tmp/couli-starts', join(directory, 'starts')),
    );
    writeFileSync(join(directory, 'entry.mjs'), ENTRY);
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function keyDirectory(directory: string, name: string, files: Record<string, string>): string {
  const path = join(directory, name);
  mkdirSync(path);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
  return path;
}

function parseEntry(line: string): Record<string, unknown> {
  let parsed: unknown;
  expect(() => {
    parsed = JSON.parse(line);
  }, 'stub entry output').not.toThrow();
  return record(parsed);
}

function boot(directory: string, env: Record<string, string>): Boot {
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(join(directory, 'boot.mjs')).href, join(directory, 'entry.mjs')],
    {
      cwd: directory,
      // Never inherit developer JWT_* variables or NODE_OPTIONS.
      env: { LC_ALL: 'C', ...env },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(result.error, 'boot must finish without a spawn error or timeout').toBeUndefined();
  expect(result.signal).toBeNull();
  const at = result.stdout.indexOf(MARKER);
  const reported = result.stdout.slice(at + MARKER.length).split('\n')[0] ?? '';
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    entry: at < 0 ? null : parseEntry(reported),
  };
}

function starts(directory: string): number {
  const path = join(directory, 'starts');
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length;
}

// Base64 lines of a PEM: boot.mjs never prints what it reads.
function expectNoKeyMaterial(output: string, pair: Pair): void {
  expect(output).not.toMatch(/-----BEGIN [A-Z ]*KEY-----/);
  for (const pem of [pair.publicPem, pair.privatePem]) {
    for (const line of pem.split('\n').filter((item) => item && !item.startsWith('-----'))) {
      expect(output).not.toContain(line);
    }
  }
}

it('[AC-B1-01zzm-BOOT#1] COULI_JWT_PUB_DIR 给出时把公钥与 kid 读进本进程、不读私钥；api 分支与不挂目录的进程照旧，两个分支互斥', () => {
  const pair = keyPair();
  fixture((directory) => {
    const verifyDir = keyDirectory(directory, 'jwt-pub', {
      'es256.pub.pem': pair.publicPem,
      'key-id': `${KID}\n`,
      // A private key left in the public directory by mistake must not reach stream.
      'es256.pem': pair.privatePem,
    });
    const stream = boot(directory, { COULI_JWT_PUB_DIR: verifyDir });
    expect(stream.status).toBe(0);
    expect(stream.entry, 'the entry module runs after boot').not.toBeNull();
    const verify = record(stream.entry);
    expect(string(verify['publicPem']).trim()).toBe(pair.publicPem.trim());
    expect(verify['keyId']).toBe(KID);
    expect(verify['privatePem'], 'stream never gets a private key').toBeNull();
    expect(stream.stdout.slice(0, stream.stdout.indexOf(MARKER)), 'boot prints nothing').toBe('');
    expectNoKeyMaterial(stream.stderr, pair);
    expect(starts(directory), 'boot still counts the container start').toBe(1);

    // Positive controls (part of this red case): api keeps the signing branch unchanged.
    const signDir = keyDirectory(directory, 'jwt', {
      'es256.pem': pair.privatePem,
      'key-id': `${KID}\n`,
    });
    const api = boot(directory, { COULI_JWT_DIR: signDir });
    expect(api.status).toBe(0);
    const sign = record(api.entry);
    expect(string(sign['privatePem']).trim()).toBe(pair.privatePem.trim());
    expect(sign['keyId']).toBe(KID);
    expect(sign['publicPem']).toBeNull();
    expectNoKeyMaterial(api.stderr, pair);

    // worker / admin / payout mount neither directory and get no JWT_* variable from boot.
    const plain = boot(directory, {});
    expect(plain.status).toBe(0);
    expect(plain.entry).toEqual({ publicPem: null, keyId: null, privatePem: null });

    // Both directories given (never in compose): refuse, or apply exactly one branch.
    const both = boot(directory, { COULI_JWT_DIR: signDir, COULI_JWT_PUB_DIR: verifyDir });
    expectNoKeyMaterial(both.stderr, pair);
    if (both.status === 0) {
      const entry = record(both.entry);
      expect(entry['privatePem'] !== null && entry['publicPem'] !== null).toBe(false);
    } else {
      expect(both.entry, 'a refusal stops before the entry module').toBeNull();
    }
  });
});

it.each(['es256.pub.pem', 'key-id'])(
  '[AC-B1-01zzm-BOOT#2] 公钥目录缺 %s 时只报路径与错误码并非零退出，不进入口、不打印内容',
  (missing) => {
    const pair = keyPair();
    fixture((directory) => {
      const files = Object.entries({ 'es256.pub.pem': pair.publicPem, 'key-id': `${KID}\n` });
      const present = Object.fromEntries(files.filter(([file]) => file !== missing));
      const verifyDir = keyDirectory(directory, 'jwt-pub', present);
      const result = boot(directory, { COULI_JWT_PUB_DIR: verifyDir });
      expect(result.status, `${missing} absent: stream must not start`).not.toBe(0);
      expect(result.entry, 'the entry module never runs').toBeNull();
      expect(result.stdout).not.toContain(MARKER);
      expect(result.stderr, 'name the directory').toContain(verifyDir);
      expect(result.stderr, 'name the error code').toContain('ENOENT');
      expect(result.stderr).not.toContain(KID);
      expectNoKeyMaterial(result.stdout + result.stderr, pair);
    });
  },
);
