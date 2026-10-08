import { readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  ENTRIES,
  HTTP_ENTRIES,
  asset,
  command,
  envFiles,
  environment,
  imageVariable,
  list,
  noInlineCredentials,
  record,
  services,
  sourceLines,
  string,
} from './kit.ts';

it('[AC-B1-01zc-COMPOSE#1] 五个常驻服务共用同一个可切换的镜像，不在节点构建或拉取', () => {
  const all = services();
  expect(Object.keys(all).sort()).toEqual([...ENTRIES].sort());
  expect(imageVariable()).not.toBe('');
  const images = ENTRIES.map((name) => string(record(all[name])['image']));
  expect(new Set(images).size).toBe(1);
  expect(images[0]).not.toMatch(/:latest\b/);
  for (const name of ENTRIES) {
    const service = record(all[name]);
    expect(service['build']).toBeUndefined();
    expect(service['extends']).toBeUndefined();
    expect(service['profiles']).toBeUndefined();
    expect(service['pull_policy'], name).toBe('never');
    expect(['always', 'unless-stopped', 'on-failure']).toContain(service['restart']);
  }
});

it.each(ENTRIES)('[AC-B1-01zc-COMPOSE#2] %s 选择对应的后端进程入口', (name) => {
  const service = record(services()[name]);
  const entry = command(service['command']);
  // Supports an image dispatcher taking `api`, or direct node main.api.js commands.
  expect(entry).toMatch(new RegExp(`(?:^|[ /])(?:main\\.)?${name}(?:\\.js)?$`));
  expect(entry).not.toMatch(/\b(?:echo|true|sleep)\b/);
});

it.each(ENTRIES)('[AC-B1-01zc-ENV#1] %s 只读自己的节点环境文件', (name) => {
  const service = record(services()[name]);
  expect(envFiles(service['env_file'])).toEqual([
    name === 'payout' ? '/etc/couli/staging-payout.env' : '/etc/couli/staging.env',
  ]);
  const env = environment(service['environment']);
  const protectedKeys = Object.keys(env).filter((key) =>
    /(?:DATABASE.*URL|REDIS|PASSWORD|SECRET|TOKEN|PRIVATE_KEY)/i.test(key),
  );
  expect(protectedKeys, 'connections and credentials must come only from env_file').toEqual([]);
  // Prevent bypassing env_file isolation by mounting the host configuration directory.
  for (const volume of list(service['volumes'] ?? [])) {
    const source =
      typeof volume === 'string' ? (volume.split(':')[0] ?? '') : string(record(volume)['source']);
    expect(source).not.toMatch(/\/etc\/couli(?:\/|$)|(?:^|\/)\.env|\.env(?:$|\/)/);
    if (typeof volume === 'string') expect(volume.split(':').at(-1)).toMatch(/(?:^|,)ro(?:,|$)/);
    else expect(record(volume)['read_only']).toBe(true);
  }
  expect(service['secrets']).toBeUndefined();
  expect(service['configs']).toBeUndefined();
  expect(service['privileged']).not.toBe(true);
  expect(JSON.stringify(service)).not.toContain('staging-migrator.env');
  if (name === 'payout') expect(JSON.stringify(service)).not.toMatch(/redis|staging\.env/i);
});

it.each(HTTP_ENTRIES)('[AC-B1-01zc-HEALTH#1] %s 探测本进程 /healthz，失败返回非零', (name) => {
  const health = record(record(services()[name])['healthcheck']);
  expect(health['disable']).not.toBe(true);
  const probe = list(health['test']).map(string);
  expect(['CMD', 'CMD-SHELL']).toContain(probe[0]);
  const text = probe.slice(1).join(' ');
  // Exec arguments are not expanded by a shell. Node may use process.env directly.
  if (probe[0] === 'CMD') expect(text).not.toMatch(/\$\$?\{?[A-Za-z_]/);
  expect(text).toMatch(/http:\/\/(?:127\.0\.0\.1|localhost):/);
  expect(text).toContain('/healthz');
  const portName = `${name.toUpperCase()}_PORT`;
  expect(text, 'probe must follow this process port from the node env_file').toContain(portName);
  // Curl/wget must be installed in the runtime stage (or one of its FROM ancestors).
  // Node's built-in fetch needs no extra package. Mere successful TCP/fetch is not enough.
  const tool = /\bcurl\b/.test(text) ? 'curl' : /\bwget\b/.test(text) ? 'wget' : 'node';
  if (tool !== 'node') {
    const stages = new Map<string, boolean>();
    let installed = false;
    let alias = '';
    for (const line of sourceLines(asset('infra/staging/Dockerfile'))) {
      const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
      if (from) {
        if (alias) stages.set(alias, installed);
        installed = stages.get(from[1] ?? '') ?? false;
        alias = from[2] ?? '';
      }
      if (
        new RegExp(
          `^RUN\\s+.*\\b(?:apt-get\\s+install|apt\\s+install|apk\\s+add)\\b[^;&|]*\\b${tool}\\b`,
        ).test(line)
      )
        installed = true;
      if (new RegExp(`\\b(?:remove|purge|del)\\b[^;&|]*\\b${tool}\\b`).test(line))
        installed = false;
    }
    expect(installed, `${tool} must be installed in the runtime image`).toBe(true);
  }
  expect(
    tool === 'curl'
      ? /(?:--fail(?:-with-body)?\b|\s-[a-zA-Z]*f[a-zA-Z]*\b)/.test(text)
      : tool === 'wget'
        ? /(?:--spider\b|(?:-O\s*|--output-document(?:=|\s+))\/dev\/null\b)/.test(text)
        : /\bnode\b/.test(text) &&
          /\bfetch\(/.test(text) &&
          /(?:\.ok\b|\.status\b)/.test(text) &&
          /process\.exit\(/.test(text),
  ).toBe(true);
  expect(text).not.toMatch(/\|\|\s*(?:true|exit\s+0)|process\.exit\(0\)\s*;?\s*$/);
  expect(string(health['interval'])).toMatch(/^[1-9]\d*(?:ms|s|m)$/);
  expect(string(health['timeout'])).toMatch(/^[1-9]\d*(?:ms|s|m)$/);
  expect(Number.isSafeInteger(health['retries'])).toBe(true);
  expect(health['retries']).toBeGreaterThan(0);
  // Compose consumes $ first; container-time variables must use $$ in the YAML.
  expect(text).not.toMatch(new RegExp(`(?<!\\$)\\$(?!\\$)\\{?${portName}\\b`));
});

it('[AC-B1-01zc-ENV#3] 所有部署交付文件（含 README）不含内联口令', () => {
  asset('infra/staging/README.md');
  const directory = new URL('../../../../infra/staging/', import.meta.url);
  const scan = (url: URL, prefix: string): void => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const path = `${prefix}/${entry.name}`;
      expect(entry.isSymbolicLink(), 'deployment assets must be local regular files').toBe(false);
      // Never read actual environment files, even if one was accidentally checked in.
      expect(entry.name).not.toMatch(/^\.env(?:\.|$)|\.env$/);
      if (entry.isDirectory()) scan(new URL(`${entry.name}/`, url), path);
      else noInlineCredentials(asset(path));
    }
  };
  scan(directory, 'infra/staging');
});

it.each(ENTRIES)('[AC-B1-01zc-NET#1] %s 端口不发布或仅绑定 127.0.0.1', (name) => {
  const service = record(services()[name]);
  expect(service['network_mode']).toBeUndefined();
  for (const port of list(service['ports'] ?? [])) {
    if (typeof port === 'string') {
      expect(port).toMatch(/^127\.0\.0\.1:[^:]+:[^:]+$/);
    } else {
      expect(record(port)['host_ip']).toBe('127.0.0.1');
    }
  }
});

it('[AC-B1-01zc-ENV#2] compose 没有内联口令、构建指令或迁移凭据', () => {
  const text = asset('infra/staging/compose.yaml');
  noInlineCredentials(text);
  expect(text).not.toMatch(/^\s*build\s*:/m);
  expect(text).not.toContain('/etc/couli/staging-migrator.env');
});
