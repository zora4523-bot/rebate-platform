// Build-time only. Run from the repository root with:
// node apps/api/src/modules/admin/scripts/generate-permissions.ts
// Writes ../domain/permissions.gen.ts (ADMIN_PERMISSIONS) from specs/permissions.yaml (04 §11
// step-up column; 08 BR-ID-34), keeping the version string and the order of the entries. Only the
// shape the runtime type promises is checked here; permission-catalog.test.ts checks that the keys
// are exactly contracts/enums/admin.yaml `admin_permission` in enum order and that the generated
// file matches the specification. Rerun after changing the specification.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@readme/openapi-parser';

export const permissionsSpecFile = new URL(
  '../../../../../../specs/permissions.yaml',
  import.meta.url,
);
export const permissionsGenFile = new URL('../domain/permissions.gen.ts', import.meta.url);

const TIERS: ReadonlySet<unknown> = new Set(['totp', 'sms']);

function fail(file: URL, message: string): never {
  throw new Error(`${fileURLToPath(file)}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Build-time renderer: read the supplied YAML file and emit permissions.gen.ts source. */
export async function permissionsSource(inputFile: URL): Promise<string> {
  const spec: unknown = await parse(fileURLToPath(inputFile));
  if (!isRecord(spec)) fail(inputFile, 'top level must be a mapping');
  if (typeof spec['version'] !== 'string') fail(inputFile, 'version must be a string');
  const permissions = spec['permissions'];
  if (!Array.isArray(permissions)) fail(inputFile, 'permissions must be a list');
  const seen = new Set<string>();
  permissions.forEach((entry: unknown, index) => {
    const where = `permissions[${String(index)}]`;
    if (
      !isRecord(entry) ||
      typeof entry['key'] !== 'string' ||
      !(entry['step_up_tier'] === null || TIERS.has(entry['step_up_tier'])) ||
      !Array.isArray(entry['operations'])
    ) {
      fail(inputFile, `${where} must be {key, step_up_tier: totp | sms | null, operations}`);
    }
    if (seen.has(entry['key'])) fail(inputFile, `${where}: duplicate key ${entry['key']}`);
    seen.add(entry['key']);
    (entry['operations'] as unknown[]).forEach((operation: unknown, at) => {
      if (
        !isRecord(operation) ||
        typeof operation['operation'] !== 'string' ||
        !operation['operation'].startsWith(`${entry['key'] as string}.`) ||
        !TIERS.has(operation['tier']) ||
        operation['tier'] === entry['step_up_tier']
      ) {
        fail(
          inputFile,
          `${where}.operations[${String(at)}] must be {operation: <key>.<name>, tier} with a tier other than the permission's`,
        );
      }
    });
  });
  return (
    '// Generated from specs/permissions.yaml by admin/scripts/generate-permissions.ts.\n' +
    '// Do not edit by hand. Regenerate after changing the specification.\n' +
    `export const ADMIN_PERMISSIONS = ${JSON.stringify(spec, null, 2)} as const;\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(permissionsGenFile, await permissionsSource(permissionsSpecFile));
}
