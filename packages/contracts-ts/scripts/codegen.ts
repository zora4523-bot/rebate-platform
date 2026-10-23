// Generates the TypeScript view of contracts/:
//   src/openapi.gen.ts       from contracts/openapi.yaml (openapi-typescript)
//   src/enums.gen.ts         from contracts/enums/*.yaml
//   src/error-codes.gen.ts   from contracts/error-codes.yaml
//   src/bridge.gen.ts        from contracts/bridge.schema.json, routes.json, apps.json
//   src/planned-operations.gen.ts  operationIds marked `x-implementation: planned` in
//                            contracts/openapi.yaml (admin placeholders, D10-284)
//   node scripts/codegen.ts           write the generated files
//   node scripts/codegen.ts --check   exit 1 when a committed file differs from a fresh run
// Both modes first run the cross-file conformance checks (conformance.ts) and the link pattern
// table check (link-patterns.ts, specs/link-patterns.yaml), the analytics event table check
// (events.ts, specs/events.yaml), the bundled default text check (texts.ts,
// contracts/texts.default.json), the fund term key list check (fund-term-keys.ts,
// specs/fund-term-keys.yaml) and the store table check (app-stores.ts, specs/app-stores.yaml),
// and stop on a problem.
// Works offline: the contract has no remote $ref and openapi-typescript does not phone home.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import { loadEnums, loadErrorCodes, renderEnums, renderErrorCodes } from './catalog.ts';
import { checkAppStores } from './app-stores.ts';
import { loadBridgeCatalog, renderBridge } from './bridge.ts';
import { checkConformance } from './conformance.ts';
import { checkEvents } from './events.ts';
import { checkFundTermKeys } from './fund-term-keys.ts';
import { checkLinkPatterns } from './link-patterns.ts';
import { checkTexts } from './texts.ts';
import {
  bridgeGeneratedFile,
  enumsGeneratedFile,
  errorCodesGeneratedFile,
  generatedFile,
  openapiFile,
  packageDir,
  repoRoot,
} from './paths.ts';

const plannedGeneratedFile = join(packageDir, 'src', 'planned-operations.gen.ts');
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sorted operationIds of the operations under `paths` marked `x-implementation: planned` (declared
 * ahead of their route). The admin console shows a placeholder for pages that read one of them
 * and disables buttons that would call one (D10-284); the list shrinks as routes ship.
 */
function plannedOperationIds(): string[] {
  const doc = parseYamlLite(readFileSync(openapiFile, 'utf8'));
  const paths = isRecord(doc) ? doc['paths'] : undefined;
  if (!isRecord(paths)) throw new Error('contracts/openapi.yaml: `paths` is not a mapping');
  const ids = new Set<string>();
  for (const [route, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isRecord(operation) || operation['x-implementation'] !== 'planned') continue;
      const id = operation['operationId'];
      if (typeof id !== 'string' || id === '')
        throw new Error(`contracts/openapi.yaml: planned ${method} ${route} has no operationId`);
      ids.add(id);
    }
  }
  return [...ids].sort();
}

function renderPlannedOperations(ids: readonly string[]): string {
  const lines = ids.map((id) => `  ${JSON.stringify(id)},`);
  return [
    '/** operationIds still marked `x-implementation: planned` (no route yet), sorted. */',
    'export const plannedOperations: ReadonlySet<string> = new Set([',
    ...lines,
    ']);',
    '',
  ].join('\n');
}

function header(source: string): string {
  return [
    '// GENERATED FILE. Do not edit by hand.',
    `// Source: ${source}`,
    '// Regenerate: pnpm contracts:codegen (drift is checked by pnpm contracts:check)',
    '',
    '',
  ].join('\n');
}

async function renderOpenapi(): Promise<string> {
  // defaultNonNullable false: a property with a default stays optional in request types.
  const ast = await openapiTS(pathToFileURL(openapiFile), {
    silent: true,
    defaultNonNullable: false,
  });
  return header('contracts/openapi.yaml') + astToString(ast);
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const unknown = args.filter((arg) => arg !== '--check');
if (unknown.length > 0) {
  console.error(`codegen: unknown argument(s): ${unknown.join(' ')}`);
  console.error('usage: node scripts/codegen.ts [--check]');
  process.exit(2);
}

let outputs: Array<{ file: string; content: string }>;
try {
  const errors = loadErrorCodes();
  const enumDefs = loadEnums();
  const problems = [
    ...checkConformance(enumDefs, errors.codes),
    ...checkLinkPatterns(enumDefs),
    ...checkEvents(enumDefs),
    ...checkTexts(errors.codes),
    ...checkFundTermKeys(enumDefs),
    ...checkAppStores(enumDefs),
  ];
  if (problems.length > 0) {
    for (const p of problems) console.error(`codegen: conformance: ${p}`);
    process.exit(1);
  }
  outputs = [
    { file: generatedFile, content: await renderOpenapi() },
    {
      file: enumsGeneratedFile,
      content: header('contracts/enums/*.yaml') + renderEnums(enumDefs),
    },
    {
      file: errorCodesGeneratedFile,
      content: header('contracts/error-codes.yaml') + renderErrorCodes(errors.codes, errors.ranges),
    },
    {
      file: bridgeGeneratedFile,
      content:
        header('contracts/bridge.schema.json, contracts/routes.json, contracts/apps.json') +
        (await renderBridge(loadBridgeCatalog(enumDefs, errors.ranges))),
    },
    {
      file: plannedGeneratedFile,
      content: header('contracts/openapi.yaml') + renderPlannedOperations(plannedOperationIds()),
    },
  ];
} catch (err) {
  console.error(`codegen: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

let stale = 0;
for (const { file, content } of outputs) {
  const target = relative(repoRoot, file);
  if (!check) {
    writeFileSync(file, content);
    console.error(`codegen: wrote ${target}`);
    continue;
  }
  const committed = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (committed === content) {
    console.error(`codegen: ${target} is up to date`);
    continue;
  }
  stale++;
  const freshFile = join(mkdtempSync(join(tmpdir(), 'couli-codegen-')), basename(file));
  writeFileSync(freshFile, content);
  console.error(
    committed === undefined
      ? `codegen: ${target} is missing.`
      : `codegen: ${target} differs from what contracts/ generates.`,
  );
  console.error(`codegen: fresh output kept at ${freshFile}`);
}
if (stale > 0) {
  console.error('codegen: run `pnpm contracts:codegen` and commit the result.');
  process.exit(1);
}
