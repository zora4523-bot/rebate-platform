import { expect, it } from 'vitest';
import {
  ENTRIES,
  asset,
  envFiles,
  environment,
  list,
  noInlineCredentials,
  record,
  services,
  sourceLines,
} from '../staging/kit.ts';

it.each(['api', 'worker'] as const)(
  '[AC-B1-04y-COMPOSE#1] %s 只读挂载可缺的节点拼多多目录，bind 使用块状长语法',
  (entry) => {
    // Reuse the protected staging suite's YAML parser so flow-style bind cannot slip through.
    const service = record(services()[entry]);
    const mounts = list(service['volumes']).filter(
      (volume) =>
        typeof volume === 'object' &&
        volume !== null &&
        'target' in volume &&
        volume.target === '/run/couli-pdd',
    );
    expect(mounts).toHaveLength(1);
    expect(record(mounts[0])).toMatchObject({
      type: 'bind',
      source: '/etc/couli-pdd',
      target: '/run/couli-pdd',
      read_only: true,
      bind: { create_host_path: true },
    });
    expect(envFiles(service['env_file'])).toEqual(['/etc/couli/staging.env']);
    expect(asset('infra/staging/compose.yaml')).not.toMatch(/\bbind:\s*\{/);
  },
);

it('[AC-B1-04y-COMPOSE#2] 拼多多目录只给 api/worker，不在 compose 注入凭据或新增部署文件存在性门槛', () => {
  const all = services();
  const recipients: string[] = [];
  for (const name of ENTRIES) {
    const service = record(all[name]);
    const env = environment(service['environment']);
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(['PDD_CLIENT_ID']));
    expect(env['PDD_CLIENT_SECRET_FILE']).toBeUndefined();
    expect(env['PDD_CLIENT_SECRET']).toBeUndefined();
    for (const volume of list(service['volumes'] ?? [])) {
      const source = typeof volume === 'string' ? volume.split(':')[0] : record(volume)['source'];
      const target = typeof volume === 'string' ? volume.split(':')[1] : record(volume)['target'];
      expect(source).not.toMatch(/^\/etc\/couli(?:\/|$)/);
      if (String(source).includes('couli-pdd') || String(target).includes('couli-pdd')) {
        recipients.push(name);
      }
    }
  }
  expect(recipients.sort()).toEqual(['api', 'worker']);
  noInlineCredentials(asset('infra/staging/compose.yaml'));
  // The optional mount must not add a ninth required node path to the deployment preflight.
  expect(sourceLines(asset('infra/staging/deploy.sh')).join('\n')).not.toMatch(
    /couli-pdd|PDD_CLIENT|UNION_ENDPOINT_OVERRIDE_DIR/,
  );
});
