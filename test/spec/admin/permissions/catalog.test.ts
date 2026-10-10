import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import type { AdminPermissionDefinition } from '../../../../apps/api/src/modules/admin/domain/permission-catalog.ts';
import { adminSurface, enumKeys, expectedCatalog, ROOT } from './expected.ts';

function catalog(): AdminPermissionDefinition[] {
  const file = new URL('specs/permissions.yaml', ROOT);
  expect(existsSync(file), '实现阶段须补 permissions.yaml').toBe(true);
  // A plain sequence, or a named permissions sequence, has the same domain meaning.
  const parsed = parseYamlLite(readFileSync(file, 'utf8')) as
    AdminPermissionDefinition[] | { permissions: AdminPermissionDefinition[] };
  const entries = Array.isArray(parsed) ? parsed : parsed.permissions;
  expect(Array.isArray(entries)).toBe(true);
  return entries;
}

it('[AC-F1-06l#1] 权限清单逐项符合裁定，键与枚举恰好一致且不重复', () => {
  const entries = catalog();
  expect(entries.map((entry) => entry.key).sort()).toEqual(enumKeys().sort());
  expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
  expect([...entries].sort((a, b) => a.key.localeCompare(b.key))).toEqual(
    expectedCatalog().sort((a, b) => a.key.localeCompare(b.key)),
  );
});

it('[AC-F1-06l#2] 运行时权限快照与 YAML 的档位及操作例外一致', async () => {
  const entries = catalog();
  const adminDir = new URL('apps/api/src/modules/admin/', ROOT);
  const snapshots = readdirSync(adminDir, { recursive: true, encoding: 'utf8' }).filter((path) =>
    path.endsWith('.gen.ts'),
  );
  expect(snapshots.length, '权限快照必须由生成物提供').toBeGreaterThan(0);
  const generated = snapshots
    .map((path) => readFileSync(new URL(path, adminDir), 'utf8'))
    .join('\n');
  for (const key of enumKeys()) expect(generated).toContain(key);
  const surface = await adminSurface();
  expect(
    surface
      .getAdminPermissionCatalog()
      .map((entry) => ({ ...entry }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  ).toEqual(entries.sort((a, b) => a.key.localeCompare(b.key)));
});
