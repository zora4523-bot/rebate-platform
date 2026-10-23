import { expect, it } from 'vitest';
import { ENTRIES, environment, list, record, services, string } from './kit.ts';

// B1-01zzm ledger ② defines these local AC identifiers (D10-255 ①: stream only verifies tokens).
// The node directories are fixed by ops (D10-264); the container mount point is the
// implementation's choice, as long as COULI_JWT_PUB_DIR names it.
const PUBLIC_DIR = '/etc/couli-jwt-pub';
const PRIVATE_DIR = '/etc/couli-jwt';

interface Mount {
  type: string;
  source: string;
  target: string;
  readOnly: boolean;
  createsHostPath: boolean;
}

function mounts(service: Record<string, unknown>): Mount[] {
  return list(service['volumes'] ?? []).map((volume) => {
    if (typeof volume === 'string') {
      const [source = '', target = '', options = ''] = volume.split(':');
      // Short syntax silently creates a missing host directory.
      return {
        type: 'bind',
        source: source.replace(/\/+$/, ''),
        target,
        readOnly: /(?:^|,)ro(?:,|$)/.test(options),
        createsHostPath: true,
      };
    }
    const entry = record(volume);
    const bind = entry['bind'] === undefined ? {} : record(entry['bind']);
    return {
      type: string(entry['type']),
      source: string(entry['source']).replace(/\/+$/, ''),
      target: string(entry['target']),
      readOnly: entry['read_only'] === true,
      createsHostPath: bind['create_host_path'] === true,
    };
  });
}

function under(source: string, directory: string): boolean {
  return source === directory || source.startsWith(`${directory}/`);
}

it('[AC-B1-01zzm-COMPOSE#1] stream 只读挂节点公钥目录，COULI_JWT_PUB_DIR 指向挂载点，不挂私钥目录', () => {
  const stream = record(services()['stream']);
  const all = mounts(stream);
  const verify = all.filter((mount) => under(mount.source, PUBLIC_DIR));
  expect(verify, `stream mounts ${PUBLIC_DIR} exactly once`).toHaveLength(1);
  const [mount] = verify;
  expect(mount?.source).toBe(PUBLIC_DIR);
  expect(mount?.type).toBe('bind');
  expect(mount?.readOnly).toBe(true);
  // A missing public-key directory must fail the switch, not start stream with an empty mount.
  expect(mount?.createsHostPath).toBe(false);
  expect(mount?.target).toMatch(/^\/[^\s:]+$/);
  const env = environment(stream['environment']);
  expect(env['COULI_JWT_PUB_DIR'], 'boot.mjs reads the mount point').toBe(mount?.target);
  expect(env['COULI_JWT_DIR'], 'stream never gets the signing key').toBeUndefined();
  expect(all.filter((item) => under(item.source, PRIVATE_DIR))).toEqual([]);
  expect(Object.keys(env).filter((key) => key.startsWith('JWT_'))).toEqual([]);
});

it('[AC-B1-01zzm-COMPOSE#2] 公钥目录只给 stream、私钥目录仍只给 api，worker / admin / payout 两个都不挂', () => {
  const all = services();
  const publicMounts: string[] = [];
  const publicEnv: string[] = [];
  const privateMounts: string[] = [];
  const privateEnv: string[] = [];
  for (const name of ENTRIES) {
    const service = record(all[name]);
    const env = environment(service['environment']);
    for (const mount of mounts(service)) {
      if (under(mount.source, PUBLIC_DIR)) publicMounts.push(name);
      if (under(mount.source, PRIVATE_DIR)) privateMounts.push(name);
    }
    if (env['COULI_JWT_PUB_DIR'] !== undefined) publicEnv.push(name);
    if (env['COULI_JWT_DIR'] !== undefined) privateEnv.push(name);
    // Key material reaches a process only through boot.mjs, never through `docker inspect`.
    expect(
      Object.keys(env).filter((key) => key.startsWith('JWT_')),
      name,
    ).toEqual([]);
  }
  expect(publicMounts).toEqual(['stream']);
  expect(publicEnv).toEqual(['stream']);
  expect(privateMounts).toEqual(['api']);
  expect(privateEnv).toEqual(['api']);
  const api = record(all['api']);
  const [signing] = mounts(api).filter((mount) => mount.source === PRIVATE_DIR);
  expect(signing?.readOnly).toBe(true);
  expect(environment(api['environment'])['COULI_JWT_DIR']).toBe(signing?.target);
});
